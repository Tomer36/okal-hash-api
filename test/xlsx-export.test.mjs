import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import '../xlsxExport.js';

const { buildWorkbook, toExcelNumber, safeFileName, safeSheetName, crc32 } = globalThis.ReportXlsx;

// Reads the stored (uncompressed) zip the export writes back into { name: text }, checking each
// file's CRC so a corrupt archive (which Excel would refuse) fails here.
async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const files = {};
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    let data = bytes.subarray(offset + 30 + nameLength + extraLength, offset + 30 + nameLength + extraLength + size);
    if (method === 8) data = inflateRawSync(data);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files[name] = new TextDecoder().decode(data);
    offset += 30 + nameLength + extraLength + size;
  }
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'end of central directory');
  assert.equal(view.getUint16(bytes.length - 12, true), Object.keys(files).length);
  return files;
}

test('a report becomes a right-to-left workbook with a bold, frozen, filterable header', async () => {
  const files = await readZip(buildWorkbook({
    sheetName: 'דוח 198',
    headers: ['מפתח חשבון', 'שם חשבון', 'טלפון נייד', 'יתרה'],
    rows: [
      ['134043', 'אבראהים מוחמד', '0541234567', '1,234.50'],
      ['104025', 'ניזאר & בניו <בע"מ>', '', '-12'],
    ],
  }));
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /rightToLeft="1"/);
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /<autoFilter ref="A1:D3"\/>/);
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">מפתח חשבון<\/t>/);
  assert.match(sheet, /<c r="A2"><v>134043<\/v><\/c>/, 'an account key is a number');
  assert.match(sheet, /<c r="C2" t="inlineStr"><is><t xml:space="preserve">0541234567<\/t>/, 'a phone keeps its leading 0');
  assert.match(sheet, /<c r="D2"><v>1234.5<\/v><\/c>/, 'a grouped amount is a number');
  assert.match(sheet, /<c r="D3"><v>-12<\/v><\/c>/);
  assert.match(sheet, /ניזאר &amp; בניו &lt;בע&quot;מ&gt;/);
  assert.doesNotMatch(sheet, /r="C3"/, 'an empty cell is left out');
  assert.match(files['xl/workbook.xml'], /<sheet name="דוח 198"/);
});

test('only plain numbers become Excel numbers', () => {
  assert.equal(toExcelNumber('0'), 0);
  assert.equal(toExcelNumber(' 2500.75 '), 2500.75);
  assert.equal(toExcelNumber('12,345,678'), 12345678);
  for (const text of ['0541234567', '00123', '12/10/2026', '1,23', '1e5', '', 'abc', '1234567890123456']) {
    assert.equal(toExcelNumber(text), null, text);
  }
});

test('names Excel and Windows refuse are cleaned', async () => {
  assert.equal(safeFileName('183 - דו"ח תעודות: לא/מתואמת'), '183 - דוח תעודות לאמתואמת');
  assert.equal(safeSheetName('[דוח]: 1/2*?'), 'דוח   1 2');
  assert.equal(safeSheetName('x'.repeat(40)).length, 31);
  // Control characters from a provider's text field would make the sheet unreadable.
  const files = await readZip(buildWorkbook({ sheetName: 'דוח', headers: ['a'], rows: [['x\u0001y']] }));
  assert.match(files['xl/worksheets/sheet1.xml'], />xy</);
});
