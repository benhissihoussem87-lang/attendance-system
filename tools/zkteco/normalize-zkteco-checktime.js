const fs = require('fs');
const path = require('path');

const INPUT_FILE = 'att2000_checkinout_merged.csv';
const OUTPUT_FILE = 'att2000_checkinout_normalized.csv';
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

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeChecktime(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return value;
  }

  // Supported formats (local time, no timezone conversion):
  // - DD/MM/YY HH:MM:SS
  // - DD/MM/YYYY HH:MM:SS
  // - YYYY/MM/DD HH:MM:SS
  let match = raw.match(
    /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );
  if (match) {
    const year = 2000 + Number(match[3]);
    const month = match[2];
    const day = match[1];
    return `${year}-${month}-${day} ${match[4]}:${match[5]}:${match[6]}`;
  }

  match = raw.match(
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/
  );
  if (match) {
    const year = match[3];
    const month = match[2];
    const day = match[1];
    return `${year}-${month}-${day} ${match[4]}:${match[5]}:${match[6]}`;
  }

  match = raw.match(
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );
  if (match) {
    const year = match[1];
    const month = match[2];
    const day = match[3];
    return `${year}-${month}-${day} ${match[4]}:${match[5]}:${match[6]}`;
  }

  return value;
}

function normalizeCsv(lines) {
  const header = parseCsvLine(lines[0] || '');
  const checktimeIndex = header.indexOf('CHECKTIME');
  if (checktimeIndex === -1) {
    throw new Error('CSV must include CHECKTIME header.');
  }

  const outputLines = [header.map(escapeCsvCell).join(DELIMITER)];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    while (cells.length < header.length) {
      cells.push('');
    }
    const originalValue = cells[checktimeIndex] || '';
    const normalized = normalizeChecktime(originalValue);
    cells[checktimeIndex] = normalized;
    outputLines.push(cells.map(escapeCsvCell).join(DELIMITER));
  }

  return outputLines.join('\n');
}

function main() {
  const baseDir = process.cwd();
  const inputPath = path.join(baseDir, INPUT_FILE);
  const outputPath = path.join(baseDir, OUTPUT_FILE);

  const lines = readCsvLines(inputPath);
  const normalized = normalizeCsv(lines);
  fs.writeFileSync(outputPath, normalized, 'utf8');
  console.log(`Normalized CSV written to ${outputPath}`);
}

main();
