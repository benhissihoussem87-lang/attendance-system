const zktecoAdapter = require('./zktecoAdapter');

const adapters = {
  zkteco: zktecoAdapter
};

function getAdapter(adapterId) {
  const key = typeof adapterId === 'string' ? adapterId.trim().toLowerCase() : 'zkteco';
  return adapters[key] || adapters.zkteco;
}

async function discoverDevices({ adapterId, subnetTargets, options }) {
  const adapter = getAdapter(adapterId);
  const result = await adapter.discover(subnetTargets, options);
  if (Array.isArray(result)) {
    return {
      adapter_id: adapter.id,
      discovered_devices: result,
      summary: {}
    };
  }
  const discoveredDevices = result && Array.isArray(result.discovered_devices)
    ? result.discovered_devices
    : [];
  const summary = result && result.summary && typeof result.summary === 'object' && !Array.isArray(result.summary)
    ? result.summary
    : {};
  return {
    adapter_id: adapter.id,
    discovered_devices: discoveredDevices,
    summary
  };
}

module.exports = {
  discoverDevices
};
