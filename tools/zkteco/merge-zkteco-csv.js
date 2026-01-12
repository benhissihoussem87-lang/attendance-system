const fs = require('fs');
const path = require('path');

const CHECKINOUT_FILE = 'att2000_checkinout.csv';
const USERINFO_FILE = 'att2000_userinfo.csv';
const OUTPUT_FILE = 'att2000_checkinout_merged.csv';
const DELIMITER = ',';

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === DELIMITER) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function escapeCsvCell(value) {
  const raw = value === undefined || value === null ? '' : String(value);
  if (raw.includes('"') || raw.includes(DELIMITER) || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function readCsvLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r\n|\n|\r/).filter(line => line.trim() !== '');
}

function buildUserIdMap(lines) {
  const header = parseCsvLine(lines[0] || '');
  const userIdIndex = header.indexOf('USERID');
  const badgeIndex = header.indexOf('Badgenumber');

  if (userIdIndex === -1 || badgeIndex === -1) {
    throw new Error('USERINFO.csv must include USERID and Badgenumber headers.');
  }

  const map = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const userId = (cells[userIdIndex] || '').trim();
    const badgeNumber = (cells[badgeIndex] || '').trim();
    if (userId) {
      map.set(userId, badgeNumber);
    }
  }
  return map;
}

function mergeCheckinout(lines, userIdMap) {
  const header = parseCsvLine(lines[0] || '');
  const userIdIndex = header.indexOf('USERID');
  if (userIdIndex === -1) {
    throw new Error('CHECKINOUT.csv must include USERID header.');
  }

  const outputHeader = header.includes('Badgenumber')
    ? header.slice()
    : header.concat('Badgenumber');

  const outputLines = [outputHeader.map(escapeCsvCell).join(DELIMITER)];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const userId = (cells[userIdIndex] || '').trim();
    const badgeNumber = userIdMap.get(userId) || '';

    const mergedCells = header.includes('Badgenumber')
      ? cells.slice(0, outputHeader.length)
      : cells.concat(badgeNumber);

    if (header.includes('Badgenumber')) {
      const badgeIndex = outputHeader.indexOf('Badgenumber');
      if (badgeIndex !== -1) {
        while (mergedCells.length <= badgeIndex) {
          mergedCells.push('');
        }
        mergedCells[badgeIndex] = badgeNumber;
      }
    }

    outputLines.push(mergedCells.map(escapeCsvCell).join(DELIMITER));
  }

  return outputLines.join('\n');
}

function main() {
  const baseDir = process.cwd();
  const checkinoutPath = path.join(baseDir, CHECKINOUT_FILE);
  const userinfoPath = path.join(baseDir, USERINFO_FILE);
  const outputPath = path.join(baseDir, OUTPUT_FILE);

  const userinfoLines = readCsvLines(userinfoPath);
  const checkinoutLines = readCsvLines(checkinoutPath);

  // Step 1: build USERID -> Badgenumber mapping from USERINFO.csv.
  const userIdMap = buildUserIdMap(userinfoLines);

  // Step 2: merge mapping into CHECKINOUT rows without reordering or validation.
  const mergedCsv = mergeCheckinout(checkinoutLines, userIdMap);

  // Step 3: write the merged output CSV in the current working directory.
  fs.writeFileSync(outputPath, mergedCsv, 'utf8');
  console.log(`Merged CSV written to ${outputPath}`);
}

main();
