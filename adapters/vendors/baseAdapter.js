const baseAdapter = {
  id: 'base',
  canHandle: () => false,
  mapRowToCanonical() {
    throw new Error('Adapter mapRowToCanonical is not implemented');
  }
};

module.exports = baseAdapter;
