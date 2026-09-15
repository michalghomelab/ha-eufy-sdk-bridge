// Startup warm-ups + the on-detection "Last event" image refresh, reading the P2P history database on
// either a HomeBase or a standalone camera. Best-effort: any failure just leaves the relevant cache
// smaller / the image stale. Every
// DB read here shares the session's single `dbChunk`/`image` stream, so they MUST NOT overlap — a
// shared lock (`withDbLock`) serialises the face-roster warm, the boot image warm, and every live
// refresh into one at-a-time queue. Kicked off the boot critical path (they don't gate `ready`).
import fs from "node:fs";
import path from "node:path";
import { parseFaceRoster, firstJsonObject } from "./faces.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long after a detection to wait before pulling the fresh cover: the HomeBase needs a moment to
// finish writing the new event's crop before `history_record_info` reports it. Also debounces a burst
// (auto-track fires many pushes) down to one refresh. Override with EVENT_IMAGE_REFRESH_DELAY_MS.
const REFRESH_DELAY_MS = Number(process.env.EVENT_IMAGE_REFRESH_DELAY_MS) || 3000;

// The HomeBase writes a new event's crop SECONDS after the motion push, and not on a fixed delay — a
// single early query gets the previous cover ("unchanged") or a crop-less record, so "Last event"
// advances its date but shows the previous image. So the local-cover refresh RETRIES on an escalating
// schedule until a genuinely-new image lands (then nudges HA once and stops). ~60s of coverage total.
const LOCAL_REFRESH_SCHEDULE = (process.env.EVENT_IMAGE_REFRESH_SCHEDULE_MS || "3000,4000,6000,10000,15000,20000")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// The fast schedule above (~58s) often expires BEFORE the HomeBase overwrites the rolling cover with
// the new frame — which is exactly why the manual "Refresh Last Event" button (pressed later) works
// when the auto-refresh didn't. So after the fast ramp, keep polling at a steady interval up to a cap,
// so the late write is caught automatically and the button becomes unnecessary. Env-tunable.
const LOCAL_REFRESH_TAIL_MS = Number(process.env.EVENT_IMAGE_REFRESH_TAIL_MS) || 30000;
const LOCAL_REFRESH_MAX_MS = Number(process.env.EVENT_IMAGE_REFRESH_MAX_MS) || 240000;

const compactDate = (date) => date.toISOString().slice(0, 10).replaceAll("-", "");

/** Normalise HomeBase FULL_TABLE (10000) and standalone QUERY_LOCAL (10017) replies. */
export function historyRecords(response) {
  if (!Array.isArray(response?.data)) return [];
  return response.data.flatMap((entry) => {
    if (entry?.table_name !== "history_record_info") return entry?.device_sn ? [entry] : [];
    return Array.isArray(entry.payload) ? entry.payload : [];
  });
}

export function createWarmup(ctx) {
  const { eufy, eventImageDir } = ctx;
  const { faceNames } = ctx.state;

  // ── shared serialisation for every P2P DB read (they share one dbChunk/image stream per session) ──
  let dbChain = Promise.resolve();
  function withDbLock(fn) {
    const result = dbChain.then(fn, fn); // run after the previous op settles, success or failure
    dbChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** The admin/account id the P2P DB queries key off — from a shared device's member record, else the login. */
  async function accountIdOf(devs) {
    return devs.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId ?? "";
  }

  /** Sessions come up asynchronously after login — wait (up to ~20s) for at least one to appear. */
  async function awaitSessions() {
    let sessions = eufy.getP2pSessions();
    for (let i = 0; i < 20 && sessions.size === 0; i++) {
      await sleep(1000);
      sessions = eufy.getP2pSessions();
    }
    return sessions;
  }

  // Standard "read the whole table" query the app uses (inner cmd 10000). We only need the newest few
  // rows, so `count` is modest — but ordering isn't guaranteed, so we still sort by `start_time` below.
  // Kept small (50): the direct read spans many P2P datagrams, and a big response often didn't finish
  // reassembling before we parsed it, which returned no records ("no local cover found") intermittently.
  const HISTORY_TABLE_QUERY = {
    count: 50,
    start_date: "",
    end_date: "",
    start_id: 0,
    end_id: 1,
    flag: 0,
    need_ai: 1,
    res_unzip: 1,
    update_time: "0",
    start_time: "0",
    alarm_id: "",
  };

  /**
   * The on-HomeBase per-event crop path for a `history_record_info` record.
   *
   * On HomeBase-3 local storage the record has NO dedicated crop field — only a bare `thumb_path`
   * ("snapshort.jpg") that resolves to one generic rolling image (so bytes never change), plus a
   * `storage_path` = the event's recording under a per-event directory
   * (…/<yyyymmddHHMMSS>/<…>.zxvid). The event still lives beside the video, so we join the recording's
   * DIRECTORY with the thumb filename → a path that's unique per event and actually advances. Absolute
   * crop fields (other firmwares) are used as-is; a bare thumb with no storage_path is the last resort.
   */
  function cropPathOf(rec) {
    const pl = rec?.payload ?? rec;
    const absolute = pl?.crop_hb3_path || pl?.crop_path || pl?.pic_path;
    if (typeof absolute === "string" && absolute.startsWith("/")) return absolute;

    const thumb = pl?.thumb_path || pl?.thumbnail_path || absolute;
    if (typeof thumb !== "string" || !thumb) return undefined;
    if (thumb.startsWith("/")) return thumb; // already a full path
    const storage = pl?.storage_path;
    if (typeof storage === "string" && storage.includes("/")) {
      const dir = storage.slice(0, storage.lastIndexOf("/"));
      if (dir) return `${dir}/${thumb}`; // per-event dir + thumb filename
    }
    return thumb; // bare filename fallback (generic, but better than nothing)
  }

  /** Recency key for a history record; higher = newer. `record_id` is monotonic per event; fall back to
   * the `start_time`/`end_time` datetime string (epoch ms). 0 only when the firmware gives us nothing. */
  function recordTime(rec) {
    const pl = rec?.payload ?? rec;
    const rid = Number(pl?.record_id ?? rec?.record_id);
    if (Number.isFinite(rid) && rid > 0) return rid;
    const t = Date.parse(pl?.start_time ?? pl?.end_time ?? pl?.create_time ?? "");
    return Number.isFinite(t) ? t : 0;
  }

  /**
   * Query each device's LATEST event cover over P2P and return `device_sn -> local cover path`
   * (the plain-JPEG crop the /event-image serves).
   *
   * HomeBase uses the DIRECT table read (inner cmd **10000**, channel **255**). A standalone camera such
   * as T8410 uses QUERY_LOCAL (inner cmd **10017**, channel **0**) with the device/date filter used by
   * eufy-security-client; that reply groups rows under `{table_name, payload}`. `historyRecords()`
   * normalises both shapes before we select the newest record per device.
   *
   * Sent twice (the first can be dropped during handshake). Caller must hold the DB lock.
   */
  async function queryStationCovers(session, accountId, { deviceSn, standalone = false } = {}) {
    let chunk = "";
    const onChunk = ({ text }) => (chunk += text);
    session.on("dbChunk", onChunk);
    const channel = standalone ? 0 : 255;
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60_000);
    const query = standalone
      ? {
          count: 20,
          detection_type: 0,
          device_info: [{ device_sn: deviceSn }],
          end_date: compactDate(end),
          event_type: 0,
          flag: 0,
          res_unzip: 1,
          start_date: compactDate(start),
          start_time: `${compactDate(start)}000000`,
          storage_cloud: -1,
          ai_type: 0,
        }
      : HISTORY_TABLE_QUERY;
    const send = () => {
      if (!session.isConnected) return;
      session.queryDatabase("history_record_info", {
        accountId,
        channel,
        innerCmd: standalone ? 10017 : 10000,
        query,
      });
    };
    send();
    setTimeout(send, 1500);

    // Poll for a FULLY-reassembled response rather than parsing once after a fixed wait: the direct read
    // can span many datagrams, and a fixed 6s window frequently closed mid-reassembly → `firstJsonObject`
    // returned nothing → "no local cover found" even though the cover existed. Exit as soon as we have a
    // parseable object carrying `data[]`; give it up to ~14s (the resend lands at 1.5s).
    let parsed;
    for (let i = 0; i < 70; i++) {
      await sleep(200);
      const obj = firstJsonObject(chunk);
      if (obj && Array.isArray(obj.data) && obj.data.length) {
        parsed = obj;
        break;
      }
    }
    session.off?.("dbChunk", onChunk);

    const records = historyRecords(parsed ?? firstJsonObject(chunk));
    if (!records.length) {
      // Diagnostic: distinguish "response never arrived" (chunk empty) from "arrived but unparseable /
      // no data" (chunk large) so a recurring failure points straight at transport vs shape.
      ctx.eventLog?.(`history query: no records parsed (raw ${chunk.length}B received)`);
    }
    // Keep the newest record per device (max start_time), then take its crop path. Ties (or a firmware
    // that omits start_time) fall back to last-wins, matching the old behaviour for that degenerate case.
    // Also track, per device, how many records mention it and the newest ts seen even when it has no crop
    // — so a stale/"unchanged" cover can be told apart from a newer record we skipped for lacking a crop.
    const newest = new Map(); // device_sn -> { ts, path }
    const seen = new Map(); // device_sn -> { count, maxTs, maxTsHasCrop }
    for (const rec of records) {
      const dsn = rec?.device_sn;
      if (!dsn) continue;
      const ts = recordTime(rec);
      const p = cropPathOf(rec);
      const s = seen.get(dsn) ?? { count: 0, maxTs: -1, maxTsHasCrop: false };
      s.count += 1;
      if (ts > s.maxTs) {
        s.maxTs = ts;
        s.maxTsHasCrop = Boolean(p);
      }
      seen.set(dsn, s);
      if (!p) continue;
      const cur = newest.get(dsn);
      if (!cur || ts >= cur.ts) newest.set(dsn, { ts, path: p, rec, channel });
    }
    return { covers: newest, recordCount: records.length, seen };
  }

  /** Request one local cover path over P2P and return its JPEG bytes (≤8s), or undefined. */
  async function fetchImage(session, filePath, accountId, channel = 255) {
    const images = new Map();
    const onImage = ({ file, data }) => {
      if (data?.[0] === 0xff && data?.[1] === 0xd8) images.set(file, data);
    };
    session.on("image", onImage);
    session.requestImage(filePath, { accountId, channel });
    for (let i = 0; i < 40 && !images.has(filePath); i++) await sleep(200);
    session.off?.("image", onImage);
    return images.get(filePath);
  }

  /** Persist bytes to last-event-<sn>.jpg only when they differ from what's on disk; report whether it changed. */
  function persistIfChanged(dsn, data) {
    const file = path.join(eventImageDir, `last-event-${dsn}.jpg`);
    let prev;
    try {
      prev = fs.readFileSync(file);
    } catch {
      prev = undefined;
    }
    if (prev && prev.equals(data)) return false;
    fs.writeFileSync(file, data);
    return true;
  }

  /**
   * Build the face-recognition roster by reading `person_basic_info` off each connected HomeBase over P2P
   * (CMD_DATABASE 1306 / inner cmd 10000, mChannel 255). Faces are account-wide, so every station's rows
   * merge into one map. On any failure the map just stays smaller and `personDetected` falls back to Unknown.
   */
  async function warmFaceRoster() {
    return withDbLock(async () => {
      try {
        const devs = await eufy.getDevices();
        const accountId = await accountIdOf(devs);
        for (const [, session] of await awaitSessions()) {
          for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500);
          if (!session.isConnected) continue;

          let chunk = "";
          const onChunk = ({ text }) => (chunk += text);
          session.on("dbChunk", onChunk);
          session.requestFaces({ accountId });
          setTimeout(() => session.isConnected && session.requestFaces({ accountId }), 1500);
          await sleep(6000);
          session.off?.("dbChunk", onChunk);

          let added = 0;
          for (const [id, rec] of parseFaceRoster(chunk)) {
            if (!faceNames.has(id)) added++;
            faceNames.set(id, rec);
          }
          if (added) console.log(`[bridge] face roster: +${added} person(s) (${faceNames.size} total)`);
        }
      } catch (e) {
        console.error(`[bridge] warm face roster failed: ${e?.message ?? e}`);
      }
    });
  }

  /**
   * Warm the "Last event" thumbnails from LOCAL storage, so images are populated on first HA
   * load even before any live push. This is the only startup source for local-storage accounts (the cloud
   * events/list + cover_path are empty without cloud storage), and — because push notifications on such
   * accounts carry no `pic_url` — {@link refreshLastEventImageFor} is also the only LIVE source, so this
   * path and that one share the same helpers.
   */
  async function warmLastEventImages() {
    return withDbLock(async () => {
      try {
        const devs = await eufy.getDevices();
        const recordsBySn = new Map(devs.map((device) => [device.sn, device]));
        const accountId = await accountIdOf(devs);
        for (const [sessionSn, session] of await awaitSessions()) {
          for (let i = 0; i < 30 && !session.isConnected; i++) await sleep(500); // await handshake
          if (!session.isConnected) continue;

          const owner = recordsBySn.get(sessionSn);
          const standalone = owner ? owner.stationSn === owner.sn && owner.deviceClass !== "homebase" : false;
          const { covers } = await queryStationCovers(session, accountId, {
            deviceSn: standalone ? sessionSn : undefined,
            standalone,
          });
          if (!covers.size) continue;

          for (const [dsn, { path: filePath, channel }] of covers) {
            const data = await fetchImage(session, filePath, accountId, channel);
            if (data && persistIfChanged(dsn, data)) {
              console.log(`[bridge] warmed last-event image for ${dsn} (${data.length}B, local)`);
            }
          }
        }
      } catch (e) {
        console.error(`[bridge] warm last-event images failed: ${e?.message ?? e}`);
      }
    });
  }

  /**
   * Pull the freshest local cover for ONE device from its P2P storage and persist it to
   * last-event-<sn>.jpg. This is what actually advances "Last event" on a local-storage account: the SDK's
   * push-thumbnail cache (`camera.snapshotStored()`) stays empty because such accounts' pushes carry no
   * cloud `pic_url`, so /event-image would otherwise serve the boot-warmed image forever. Returns true when
   * the bytes changed (so the caller can nudge HA to re-fetch). Serialised against every other DB read.
   */
  function refreshLastEventImageFor(sn) {
    return withDbLock(async () => {
      if (!sn) return false;
      try {
        const devs = await eufy.getDevices();
        const target = devs.find((device) => device.sn === sn);
        if (!target) return false;
        const stationSn = target.stationSn ?? sn;
        const standalone = stationSn === sn && target.deviceClass !== "homebase";
        const session = eufy.getP2pSessions().get(stationSn);
        if (!session?.isConnected) return false;
        const accountId = await accountIdOf(devs);
        const { covers, recordCount, seen } = await queryStationCovers(session, accountId, {
          deviceSn: sn,
          standalone,
        });
        const entry = covers.get(sn);
        if (!entry) {
          // A newer record without a crop means the event exists but its image is not ready yet.
          const s = seen?.get(sn);
          if (s) {
            ctx.eventLog?.(
              `local refresh: ${sn} — no crop in its ${s.count} record(s) here ` +
                `(newest ts=${s.maxTs}, hasCrop=${s.maxTsHasCrop}; ${recordCount} total)`,
            );
          }
          return false;
        }
        const filePath = entry.path;
        const crop = filePath.split("/").pop();
        const data = await fetchImage(session, filePath, accountId, entry.channel);
        if (!data) {
          ctx.eventLog?.(`local refresh: ${sn} — cover fetch returned no image (crop=${crop})`);
          return false;
        }
        if (persistIfChanged(sn, data)) {
          ctx.eventLog?.(
            `local refresh: ${sn} → last-event image updated (${data.length}B, local) ` +
              `[ts=${entry.ts} crop=${crop} of ${recordCount} recs]`,
          );
          return true;
        }
        ctx.eventLog?.(
          `local refresh: ${sn} — cover unchanged (${data.length}B) [ts=${entry.ts} crop=${crop} of ${recordCount} recs]`,
        );
        // One-shot structure dump on the failing path: the picked record's field names + a truncated
        // JSON, so we can find the real per-event crop-path field and timestamp on unfamiliar firmware.
        try {
          const rec = entry.rec ?? {};
          const keys = Object.keys(rec).join(",");
          const pkeys = Object.keys(rec.payload ?? {}).join(",");
          ctx.eventLog?.(`local refresh: ${sn} — record keys=[${keys}] payload=[${pkeys}]`);
          ctx.eventLog?.(`local refresh: ${sn} — record sample=${JSON.stringify(rec).slice(0, 700)}`);
        } catch {
          /* best-effort diagnostic */
        }
        return false;
      } catch (e) {
        console.error(`[bridge] local refresh for ${sn} failed: ${e?.message ?? e}`);
        return false;
      }
    });
  }

  /**
   * Advance "Last event" from the SDK's PUSHED thumbnail (cloud `pic_url`) — the path a doorbell / cloud
   * camera uses (its P2P `history_record_info` returns nothing, so {@link refreshLastEventImageFor} can't
   * help it). `StoredImageCache` downloads the thumbnail lazily and emits no "ready" event, so right after
   * the push `snapshotStored()` is often still `pending`/`download-failed`; HA's immediate fetch then gets
   * the stale disk copy and never re-fetches. So we retry across a bounded window and persist+report the
   * moment a NEW image lands, letting the caller nudge HA. `not-observed`/`invalid-image` mean there is no
   * pushed thumbnail (a pure local-storage cam) — give up immediately and let the P2P path handle it.
   */
  async function refreshStoredSnapshotFor(sn) {
    let cam;
    try {
      cam = (await ctx.deviceFor(sn)).camera?.();
    } catch {
      return false;
    }
    if (!cam?.snapshotStored) return false;
    for (let i = 0; i < 12; i++) {
      // ~30s total (12 × 2.5s) — long enough for a slow cloud thumbnail download to land.
      let jpeg;
      try {
        jpeg = await cam.snapshotStored();
      } catch (e) {
        const reason = e?.reason ?? e?.message ?? e;
        if (reason !== "pending" && reason !== "download-failed") return false; // not-observed / invalid
        await sleep(2500);
        continue;
      }
      if (jpeg?.length && persistIfChanged(sn, jpeg)) {
        ctx.eventLog?.(`stored snapshot: ${sn} → last-event image updated (${jpeg.length}B, push)`);
        return true;
      }
      return false; // got bytes but unchanged — nothing new to nudge about
    }
    ctx.eventLog?.(`stored snapshot: ${sn} — no push thumbnail landed in time`);
    return false;
  }

  /** Nudge HA to pull /event-image only after the bridge has retained genuinely new bytes. */
  const nudge = (sn, changed) => {
    if (changed) ctx.broadcast?.({ event: "eventImageUpdated", deviceSn: sn });
  };

  // In-flight guard per device: a burst of pushes (auto-track fires many) collapses to the one retry
  // loop already running for that device.
  const pendingRefresh = new Set(); // sn
  function onDetectionRefresh(sn) {
    if (!sn || pendingRefresh.has(sn)) return;
    pendingRefresh.add(sn);
    // Pushed cloud thumbnail (doorbell / cloud cams): its own internal retry window; nudge if it lands.
    void refreshStoredSnapshotFor(sn).then((changed) => nudge(sn, changed));
    // On-HomeBase local cover (local-storage cams): RETRY across the escalating schedule until a fresh
    // image lands — the HomeBase writes the new crop a few seconds after the push, so a single early
    // query is exactly what leaves "Last event" one image behind. Stop at the first genuine change.
    void (async () => {
      try {
        // Fast escalating ramp for the common case, then a steady tail up to LOCAL_REFRESH_MAX_MS so a
        // late crop write is still caught without the user pressing "Refresh Last Event". Stop at the
        // first genuine change.
        let elapsed = 0;
        for (let i = 0; elapsed < LOCAL_REFRESH_MAX_MS; i++) {
          const delay = i < LOCAL_REFRESH_SCHEDULE.length ? LOCAL_REFRESH_SCHEDULE[i] : LOCAL_REFRESH_TAIL_MS;
          await sleep(delay);
          elapsed += delay;
          if (await refreshLastEventImageFor(sn)) {
            nudge(sn, true);
            return;
          }
        }
        ctx.eventLog?.(
          `local refresh: ${sn} — no fresh crop after ${Math.round(elapsed / 1000)}s; ` +
            `will catch on the next detection (or press "Refresh Last Event")`,
        );
      } finally {
        pendingRefresh.delete(sn);
      }
    })();
  }

  /**
   * Force an immediate "Last event" image refresh for a device, bypassing the debounce/retry schedule —
   * runs both sources once, right now, and nudges HA if a fresh image lands. Backs the manual "Refresh
   * Last Event" control, and answers whether the image actually changed so the caller can report it.
   */
  async function forceRefreshEventImage(sn) {
    if (!sn) return false;
    const [stored, local] = await Promise.all([
      refreshStoredSnapshotFor(sn).catch(() => false),
      refreshLastEventImageFor(sn).catch(() => false),
    ]);
    const changed = Boolean(stored || local);
    nudge(sn, changed);
    ctx.eventLog?.(`force refresh: ${sn} → ${changed ? "image updated" : "no newer image available yet"}`);
    return changed;
  }

  return {
    warmFaceRoster,
    warmLastEventImages,
    refreshLastEventImageFor,
    refreshStoredSnapshotFor,
    onDetectionRefresh,
    forceRefreshEventImage,
  };
}
