// The host-facing view of a device: identity + capabilities + live property values + a stream path for
// cameras. This is the shape the WS `devices.list` / `device.state` / `device.properties` commands and
// the go2rtc camera registration both read, so a camera is "a device describeDevice gave a `stream`",
// not `deviceClass === "camera"` (the SDK downgrades a camera behind a HomeBase to "other").

export function createDeviceView(ctx) {
  const { eufy } = ctx;
  const { streaming } = ctx.state;
  const models = new Map();
  const modelInFlight = new Map();
  let rosterLoaded = false;
  let rosterInFlight;

  /**
   * Return the one long-lived Device model for a serial. Keeping a strong reference is intentional:
   * the SDK applies poll/realtime changes to the model it handed the host, and only weakly retains it
   * itself. Recreating it for every HTTP/WS call both refetched params and detached the old model from
   * future `propertyChanged` updates.
   */
  async function deviceFor(sn) {
    const cached = models.get(sn);
    if (cached) return cached;
    let pending = modelInFlight.get(sn);
    if (!pending) {
      pending = eufy
        .getDevice(sn)
        .then((dev) => {
          models.set(sn, dev);
          return dev;
        })
        .finally(() => modelInFlight.delete(sn));
      modelInFlight.set(sn, pending);
    }
    return pending;
  }

  /**
   * Build the host-facing summary of one device: identity + capabilities + a stream path for a camera.
   *
   * `name` is the owner's device name (falling back to the product name when unnamed), `model` is the
   * T-code, `modelName` is the product. A host shows `name` as the device name and `model`/`modelName`
   * as its model — no cross-referencing the device list.
   */
  async function describeDevice(sn) {
    const dev = await deviceFor(sn);
    return describeModel(dev);
  }

  function describeModel(dev) {
    const m = dev.describe();
    const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
    const read = dev.getProperties();
    return {
      sn: m.sn,
      name: m.name, // owner's device name (e.g. "Dining room"), from device_name
      model: m.model || m.modelName, // T-code (e.g. "T8410"); product name as fallback
      modelName: m.modelName, // product display name (e.g. "Indoor Cam Pan & Tilt")
      codec: m.codec,
      capabilities: m.capabilities,
      state: propertyState(dev, read), // live values ({ battery: 74, motion: false, … })
      properties: propertySpecs(dev, read), // same snapshot: HA needs no follow-up RPC per device
      stream: isCamera ? `/stream/${m.sn}` : undefined,
      streaming: isCamera ? streaming.has(m.sn) : undefined, // live P2P feed active right now?
      canReboot: m.codec === "station", // HomeBase-only; drives a Reboot button in HA
    };
  }

  /** Live property values as a flat `{ name: value }` map (reading schedules a background refresh). */
  function propertyState(dev, read = dev.getProperties()) {
    const out = {};
    for (const [name, pv] of Object.entries(read)) out[name] = pv.value;
    return out;
  }

  /**
   * The device's property manifest — the host-relevant half of each PropertySpec, so a frontend can
   * build the right entity (writable bool → switch, enum → select, number → number, else sensor)
   * without knowing eufy wire ids. Wire-only fields (paramType, decode, aliases) are omitted.
   */
  function propertySpecs(dev, read = dev.getProperties()) {
    // A missing value does not mean a property is bogus. Several legitimate controls can be written
    // over P2P even though this camera's cloud snapshot never reports them. Model support is decided
    // in the SDK's availability gates; here we keep every observed property plus every writable one.
    // Only a property that is both unread and read-only is useless to a host.
    return (dev.properties ?? [])
      .filter((p) => p.name in read || p.writable)
      .map((p) => ({
        name: p.name,
        type: p.type, // "bool" | "number" | "string" | "enum"
        unit: p.unit, // "%", "°C", "dBm", …
        kind: p.kind, // percent | celsius | dbm | seconds | …
        writable: p.writable, // a setter exists (device.set accepts it)
        enumValues: p.enumValues, // { raw: label } for enums
        description: p.description,
      }));
  }

  function cachedList() {
    return [...models.values()].map(describeModel);
  }

  async function refreshDeviceList() {
    const devices = await eufy.getDevices();
    const resolved = await Promise.all(
      devices.map(async (record) => {
        try {
          return { sn: record.sn, dev: await eufy.getDevice(record.sn) };
        } catch (error) {
          return { sn: record.sn, error: String(error?.message ?? error) };
        }
      }),
    );
    models.clear();
    const errors = [];
    for (const item of resolved) {
      if (item.dev) models.set(item.sn, item.dev);
      else errors.push({ sn: item.sn, error: item.error });
    }
    rosterLoaded = true;
    return [...cachedList(), ...errors];
  }

  /** Cached by default: the SDK owns cloud polling and updates the retained models in place. */
  async function deviceList({ refresh = false } = {}) {
    if (rosterLoaded && !refresh) return cachedList();
    rosterInFlight ??= refreshDeviceList().finally(() => {
      rosterInFlight = undefined;
    });
    return rosterInFlight;
  }

  /** A roster change invalidates inventory; the next host read rebuilds it once. */
  function invalidateDeviceList() {
    rosterLoaded = false;
  }

  return { describeDevice, deviceFor, propertyState, propertySpecs, deviceList, invalidateDeviceList };
}
