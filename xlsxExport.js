// Saves a report table as an Excel workbook (.xlsx), built here without any library or internet
// access. Every cell keeps its text as shown; plain numbers (amounts, account keys) become Excel
// numbers so they can be summed, while values such as phone numbers with a leading 0 stay text.
// Used by reports.html as window.ReportXlsx; the tests import it the same way.
(function (root) {
  const encoder = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // A zip archive with its files stored uncompressed, which is all an .xlsx needs.
  function zipStored(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // names are UTF-8
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(local.buffer), name, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  function escapeXml(value) {
    return String(value)
      // Characters XML cannot hold at all (control codes from the provider's text fields).
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // "1234.5", "-12" and "1,234.50" are numbers; "0541234567", "00123" or "12/10/2026" are not.
  const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
  const GROUPED_NUMBER = /^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;
  function toExcelNumber(text) {
    const value = String(text ?? "").trim();
    if (PLAIN_NUMBER.test(value)) return Number(value);
    if (GROUPED_NUMBER.test(value)) return Number(value.replace(/,/g, ""));
    return null;
  }

  function columnName(index) {
    let name = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
  }

  function cellXml(ref, value, style) {
    const text = String(value ?? "");
    if (text === "") return "";
    const styleAttr = style ? ` s="${style}"` : "";
    const number = style ? null : toExcelNumber(text);
    if (number !== null) return `<c r="${ref}"${styleAttr}><v>${number}</v></c>`;
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }

  // headers: column titles; rows: arrays of cell text. The sheet is right-to-left, with the
  // header row bold, frozen and filterable.
  function buildWorksheetXml(headers, rows) {
    const width = Math.max(headers.length, ...rows.map((row) => row.length), 1);
    const widths = Array.from({ length: width }, (_, column) => {
      const longest = [headers, ...rows].reduce(
        (max, row) => Math.max(max, String(row[column] ?? "").length),
        0
      );
      return Math.min(60, Math.max(8, longest + 2));
    });
    const parts = [];
    parts.push(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<sheetViews><sheetView workbookViewId="0" rightToLeft="1">',
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
      "</sheetView></sheetViews>",
      "<cols>",
      ...widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`),
      "</cols><sheetData>"
    );
    [headers, ...rows].forEach((row, rowIndex) => {
      const r = rowIndex + 1;
      const cells = [];
      for (let column = 0; column < row.length; column += 1) {
        cells.push(cellXml(`${columnName(column)}${r}`, row[column], rowIndex === 0 ? 1 : 0));
      }
      parts.push(`<row r="${r}">${cells.join("")}</row>`);
    });
    parts.push("</sheetData>");
    if (headers.length > 0) {
      parts.push(`<autoFilter ref="A1:${columnName(width - 1)}${rows.length + 1}"/>`);
    }
    parts.push("</worksheet>");
    return parts.join("");
  }

  // Excel refuses sheet names over 31 characters or with []:*?/\ in them.
  function safeSheetName(name) {
    return String(name || "דוח").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "דוח";
  }

  function buildWorkbook({ sheetName, headers, rows }) {
    return zipStored([
      {
        name: "[Content_Types].xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          "</Types>",
      },
      {
        name: "_rels/.rels",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>",
      },
      {
        name: "xl/workbook.xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${escapeXml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets>` +
          (headers.length > 0
            ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${escapeXml(safeSheetName(sheetName)).replace(/'/g, "''")}'!$A$1:$${columnName(Math.max(headers.length, 1) - 1)}$${rows.length + 1}</definedName></definedNames>`
            : "") +
          "</workbook>",
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          "</Relationships>",
      },
      {
        name: "xl/styles.xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>' +
          '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
          '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
          "</styleSheet>",
      },
      { name: "xl/worksheets/sheet1.xml", data: buildWorksheetXml(headers, rows) },
    ]);
  }

  // The table as it is on screen: its sort order and the rows and totals shown.
  function readHtmlTable(table) {
    const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.children).map((cell) => cell.textContent.trim())
    );
    return { headers, rows };
  }

  // Windows does not allow \ / : * ? " < > | in file names (report names contain דו"ח).
  function safeFileName(name) {
    return String(name || "דוח").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim() || "דוח";
  }

  function downloadWorkbook(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(fileName)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  root.ReportXlsx = { buildWorkbook, buildWorksheetXml, readHtmlTable, downloadWorkbook, toExcelNumber, safeFileName, safeSheetName, crc32 };
})(globalThis);
