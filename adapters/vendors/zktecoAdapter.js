const zktecoAdapter = {
  id: 'zkteco',
  mapRowToCanonical() {
    throw new Error('ZKTeco adapter not implemented');
  }
};

module.exports = zktecoAdapter;
