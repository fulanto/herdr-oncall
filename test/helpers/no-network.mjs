// Preloaded (NODE_OPTIONS=--import) into every process a real-entry test
// starts, the detached poller included: nothing started by such a test can
// reach a network, whatever credentials or code path it ends up on. The plugin
// has two ways out, the global fetch and the global WebSocket.
globalThis.fetch = async (url) => {
  throw new Error(`the network is off in tests: ${String(url).slice(0, 80)}`);
};
globalThis.WebSocket = class {
  constructor(url) {
    throw new Error(`the network is off in tests: ${String(url).slice(0, 80)}`);
  }
};
