// HTTP surface: live video (go2rtc pulls /stream/<sn>), a snapshot still, the persisted last-event
// thumbnail, and /healthz. Video is deliberately OFF the WS — connecting to /stream is what opens the
// camera, disconnecting is what stops it, so there's no "is it streaming" flag to drift. Returns the
// request handler; server.mjs wraps it in http.createServer.
import fs from "node:fs";
import path from "node:path";
import { streamClientFor } from "../streams.mjs";

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

export function createHttpHandler(ctx) {
  const { cfg, eufy, SCHEMA_VERSION, eventImageDir } = ctx;
  const { flags } = ctx.state;
  const { streaming, idleSuspended, activeStreams, lastPullAttempt, rtspLastActive } = ctx.state;

  return async function handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const [, kind, sn] = url.pathname.split("/");

    if (url.pathname === "/healthz") {
      const idleSec = Math.round((Date.now() - flags.lastActivity) / 1000);
      return json(res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        auth: ctx.authStatus(),
        sessionLost: flags.sessionLost, // cloud token kicked/expired since boot → re-auth in progress/needed
        streaming: [...streaming],
        idleSuspended: [...idleSuspended], // cameras auto-off for no recent detection (awaiting next one)
        streamIdleMs: cfg.streamIdleMs, // 0 = idle auto-off disabled
        lastActivitySec: idleSec, // seconds since the last poll heartbeat / realtime event
        stalled: flags.ready && idleSec * 1000 >= ctx.stallThresholdMs(),
        pushConnected: flags.pushConnected, // FCM push channel — events (motion/doorbell/…) ride this
        pushIdleSec: flags.pushConnected ? 0 : Math.round((Date.now() - flags.pushSince) / 1000),
      });
    }
    if (!flags.ready) return json(res, 503, { error: "not authenticated", auth: ctx.authStatus() });

    // FORK DIAGNOSTIC — why is half a camera's entity list stuck at "unknown"?
    //
    // A host builds its entities from the property manifest and fills them from the state map. An
    // entry present in the first and missing from the second is an entity that can never read. This
    // puts both side by side, and also asks getProperty() per name: the SDK documents the singular
    // read as serving every published entry, so if it answers where getProperties() is silent, the
    // gap is in the bulk read rather than in the device.
    if (kind === "debug" && sn) {
      const dev = await eufy.getDevice(sn);
      const meta = dev.describe();
      const specs = dev.properties ?? [];
      const bulk = dev.getProperties();
      const rows = specs.map((spec) => {
        const one = dev.getProperty?.(spec.name);
        return {
          name: spec.name,
          param: spec.param ?? null,
          type: spec.type,
          kind: spec.kind,
          writable: spec.writable ?? false,
          unexposed: spec.unexposed ?? false,
          provenance: spec.provenance ?? null,
          inBulk: spec.name in bulk,
          bulkValue: bulk[spec.name]?.value ?? null,
          singleValue: one?.value ?? null,
        };
      });
      const dark = rows.filter((r) => !r.inBulk);
      return json(res, 200, {
        sn,
        model: meta.model,
        modelName: meta.modelName,
        capabilities: meta.capabilities,
        counts: {
          manifest: rows.length,
          inBulk: rows.length - dark.length,
          dark: dark.length,
          darkButSingleAnswers: dark.filter((r) => r.singleValue !== null).length,
        },
        dark: dark.map((r) => r.name),
        properties: rows,
      });
    }

    // A current still: a fresh live burst, falling back to the retained push thumbnail.
    if (kind === "snapshot" && sn) {
      try {
        const cam = (await eufy.getDevice(sn)).camera?.();
        if (!cam) return json(res, 404, { error: "no camera on this device" });
        let jpeg;
        try {
          ({ jpeg } = await cam.snapshotLive());
        } catch {
          jpeg = await cam.snapshotStored?.(); // may throw when nothing is retained
        }
        if (!jpeg) return json(res, 404, { error: "no image available" });
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
        return res.end(jpeg);
      } catch (e) {
        return json(res, 502, { error: String(e?.message ?? e) });
      }
    }

    // The latest detection thumbnail the SDK downloaded + retained (no live capture). The SDK's cache is
    // in-memory (cleared on restart / watchdog recovery), so we also persist each served thumbnail to disk
    // and fall back to it when nothing is retained — the "Last event" image then survives restarts.
    if (kind === "event-image" && sn) {
      // HA fetches this to render "Last event" (usually right after a detection event). Trace the
      // outcome so a "Last event never updates" report shows whether HA even asked and what it got back.
      const file = path.join(eventImageDir, `last-event-${sn}.jpg`);
      try {
        const cam = (await eufy.getDevice(sn)).camera?.();
        if (!cam?.snapshotStored) {
          ctx.eventLog(`/event-image ${sn} → 404 no camera on device`);
          return json(res, 404, { error: "no camera on this device" });
        }
        const jpeg = await cam.snapshotStored();
        fs.writeFile(file, jpeg, () => {}); // best-effort persist for restart survival
        ctx.eventLog(`/event-image ${sn} → 200 live thumbnail (${jpeg.length}B) — Last event updated`);
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
        return res.end(jpeg);
      } catch (e) {
        // Nothing retained live — serve the last persisted thumbnail if we have one.
        try {
          const cached = await fs.promises.readFile(file);
          // Include WHY the live cache was empty (not-observed / pending / download-failed / invalid-image)
          // even though we can still serve a disk copy — on a local-storage account this is expected to be
          // "not-observed" (no push thumbnail), and the on-detection local refresh is what advances it.
          ctx.eventLog(
            `/event-image ${sn} → 200 cached thumbnail (${cached.length}B, from disk; live unavailable: ${e?.reason ?? e?.message ?? e}) — Last event served`,
          );
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": cached.length });
          return res.end(cached);
        } catch {
          // No live and no persisted image. Surface the SDK reason (not-observed / pending /
          // download-failed / invalid-image) so a caller can tell "no event yet" from a failure.
          ctx.eventLog(
            `/event-image ${sn} → 404 no image (reason=${e?.reason ?? e?.message ?? e}) — Last event NOT updated`,
          );
          return json(res, 404, { error: String(e?.message ?? e), reason: e?.reason });
        }
      }
    }

    if (kind === "stream" && sn) {
      if (cfg.streamIdleMs) lastPullAttempt.set(sn, Date.now()); // consumer is asking (watched vs. gone)
      // Idle-suspended: no detection recently, so don't reopen the P2P session. go2rtc's ffmpeg source
      // retries into this until a detection or the consumer giving up lifts it (see streamIdleTick).
      if (cfg.streamIdleMs && idleSuspended.has(sn))
        return json(res, 503, {
          error: "stream idle-suspended — no recent detection, waiting for motion or a fresh viewer",
        });
      try {
        const client = await streamClientFor(sn, cfg); // its OWN P2P session — see streams.mjs
        const cam = (await client.getDevice(sn)).camera?.();
        if (!cam?.openReadable) return json(res, 404, { error: "no live video on this device" });
        const feed = await cam.openReadable(); // node Readable of Annex-B
        if (!streaming.has(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: true });
        streaming.add(sn);
        activeStreams.set(sn, { feed, startedAt: Date.now() });
        rtspLastActive.set(sn, Date.now()); // a live stream counts as activity for the rtspStream auto-off
        res.writeHead(200, { "content-type": "video/H264", "cache-control": "no-cache" });
        feed.pipe(res);
        // streaming.delete returns true only on the first cleanup for this feed → broadcast "off" once.
        const cleanup = () => {
          feed.destroy();
          if (streaming.delete(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: false });
          activeStreams.delete(sn);
        };
        req.on("close", cleanup);
        feed.on("error", cleanup);
        feed.on("close", cleanup);
        return;
      } catch (e) {
        return json(res, 502, { error: String(e?.message ?? e) });
      }
    }

    return json(res, 404, { error: "not found" });
  };
}
