import fs from 'fs';
import path from 'path';

const logPath = path.join(process.cwd(), 'trade_log.csv');

export function logTrade(row: Record<string, string | number>) {
  const headers = Object.keys(row).join(',');
  const values = Object.values(row).join(',');

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, headers + '\n');
  }

  fs.appendFileSync(logPath, values + '\n');
}
