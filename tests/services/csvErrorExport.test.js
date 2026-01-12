const assert = require('assert');
const { buildErrorsCsv } = require('../../services/csvErrorExport');

function testDeterministicOrdering() {
  const validationResult = {
    errors: [
      { row_number: 3, code: 'B', message: 'b message' },
      { row_number: 2, code: 'A', message: 'a message' },
      { row_number: 2, code: 'A', message: 'b message' },
      { row_number: 2, code: 'B', message: 'a message' }
    ],
    error_intelligence: {
      recommendations: []
    }
  };
  const csv = buildErrorsCsv(validationResult);
  const lines = csv.split('\n');
  assert.strictEqual(lines[0], 'row_number,code,message,recommendation');
  assert.strictEqual(lines[1], '2,A,a message,');
  assert.strictEqual(lines[2], '2,A,b message,');
  assert.strictEqual(lines[3], '2,B,a message,');
  assert.strictEqual(lines[4], '3,B,b message,');
}

function testRecommendationMapping() {
  const validationResult = {
    errors: [
      { row_number: 5, code: 'UNKNOWN_CHECKTYPE', message: 'unknown' }
    ],
    error_intelligence: {
      recommendations: [
        {
          error_code: 'UNKNOWN_CHECKTYPE',
          recommendation: 'Configure explicit CHECKTYPE mappings before import'
        }
      ]
    }
  };
  const csv = buildErrorsCsv(validationResult);
  const lines = csv.split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(
    lines[1],
    '5,UNKNOWN_CHECKTYPE,unknown,Configure explicit CHECKTYPE mappings before import'
  );
}

function testCsvEscaping() {
  const validationResult = {
    errors: [
      {
        row_number: 1,
        code: 'ERR',
        message: 'bad, "value"\nnext'
      }
    ],
    error_intelligence: {
      recommendations: [
        { error_code: 'ERR', recommendation: 'fix "data"' }
      ]
    }
  };
  const csv = buildErrorsCsv(validationResult);
  assert.strictEqual(
    csv.startsWith('row_number,code,message,recommendation\n'),
    true
  );
  assert.strictEqual(
    csv.includes('1,ERR,"bad, ""value""\nnext","fix ""data"""'),
    true
  );
}

function run() {
  testDeterministicOrdering();
  testRecommendationMapping();
  testCsvEscaping();
  console.log('csvErrorExport tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
