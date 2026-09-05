import PDFFont from '../font';
import { WIN_ANSI_MAP } from './afm';

const toHex = function (num) {
  return `0000${num.toString(16)}`.slice(-4);
};

// Inverse of WIN_ANSI_MAP (code point -> WinAnsiEncoding code), for the one
// block (0x80-0x9F) where the two diverge; every other code between
// FIRST_WIN_ANSI_CHAR and LAST_WIN_ANSI_CHAR maps 1:1 to the same code point.
const WIN_ANSI_CODE_TO_UNICODE = Object.fromEntries(
  Object.entries(WIN_ANSI_MAP).map(([codePoint, code]) => [
    code,
    Number(codePoint),
  ]),
);
const UNDEFINED_WIN_ANSI_CODES = new Set([129, 141, 143, 144, 157]); // unused slots in that block
const FIRST_WIN_ANSI_CHAR = 32;
const LAST_WIN_ANSI_CHAR = 255;

function unicodeForWinAnsiCode(code) {
  if (UNDEFINED_WIN_ANSI_CODES.has(code)) {
    return null;
  }
  return WIN_ANSI_CODE_TO_UNICODE[code] ?? code;
}

class EmbeddedFont extends PDFFont {
  constructor(document, font, id) {
    super();
    this.document = document;
    this.font = font;
    this.id = id;
    this.subset = this.font.createSubset();
    this.unicode = [[0]];
    this.widths = [this.font.getGlyph(0).advanceWidth];

    this.name = this.font.postscriptName;
    this.scale = 1000 / this.font.unitsPerEm;
    this.ascender = this.font.ascent * this.scale;
    this.descender = this.font.descent * this.scale;
    this.xHeight = this.font.xHeight * this.scale;
    this.capHeight = this.font.capHeight * this.scale;
    this.lineGap = this.font.lineGap * this.scale;
    this.bbox = this.font.bbox;

    if (document.options.fontLayoutCache !== false) {
      this.layoutCache = Object.create(null);
    }
  }

  layoutRun(text, features) {
    const run = this.font.layout(text, features);

    // Normalize position values
    for (let i = 0; i < run.positions.length; i++) {
      const position = run.positions[i];
      for (let key in position) {
        position[key] *= this.scale;
      }

      position.advanceWidth = run.glyphs[i].advanceWidth * this.scale;
    }

    return run;
  }

  layoutCached(text) {
    if (!this.layoutCache) {
      return this.layoutRun(text);
    }
    let cached;
    if ((cached = this.layoutCache[text])) {
      return cached;
    }

    const run = this.layoutRun(text);
    this.layoutCache[text] = run;
    return run;
  }

  layout(text, features, onlyWidth) {
    // Skip the cache if any user defined features are applied
    if (features) {
      return this.layoutRun(text, features);
    }

    let glyphs = onlyWidth ? null : [];
    let positions = onlyWidth ? null : [];
    let advanceWidth = 0;

    // Split the string by words to increase cache efficiency.
    // For this purpose, spaces and tabs are a good enough delimeter.
    let last = 0;
    let index = 0;
    while (index <= text.length) {
      var needle;
      if (
        (index === text.length && last < index) ||
        ((needle = text.charAt(index)), [' ', '\t'].includes(needle))
      ) {
        const run = this.layoutCached(text.slice(last, ++index));
        if (!onlyWidth) {
          glyphs = glyphs.concat(run.glyphs);
          positions = positions.concat(run.positions);
        }

        advanceWidth += run.advanceWidth;
        last = index;
      } else {
        index++;
      }
    }

    return { glyphs, positions, advanceWidth };
  }

  encode(text, features) {
    const { glyphs, positions } = this.layout(text, features);

    const res = [];
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i];
      const gid = this.subset.includeGlyph(glyph.id);
      res.push(`0000${gid.toString(16)}`.slice(-4));

      if (this.widths[gid] == null) {
        this.widths[gid] = glyph.advanceWidth * this.scale;
      }
      if (this.unicode[gid] == null) {
        this.unicode[gid] = glyph.codePoints;
      }
    }

    return [res, positions];
  }

  widthOfString(string, size, features) {
    const width = this.layout(string, features, true).advanceWidth;
    const scale = size / 1000;
    return width * scale;
  }

  /**
   * Returns the PDFReference to use for this font in an AcroForm's /DR and
   * /DA resources, embedding a dedicated font for that purpose the first
   * time it's requested.
   *
   * This can't reuse `ref()`: that font is a Type0 composite font under
   * `/Encoding /Identity-H`, subsetted down to only the glyphs used in
   * content streams pdfkit writes itself, which address glyphs directly by
   * glyph ID and therefore never need a `cmap` table (pdfkit's subsetter
   * omits it). But pdfkit's `initForm()` always sets `NeedAppearances`,
   * which asks the reader to regenerate a field's appearance from its
   * plain-text value at any time -- and Identity-H gives it no character
   * encoding to resolve that text against. Without a way to map field text
   * to glyphs, readers such as Adobe Acrobat/Reader silently fall back to a
   * substitute font (see foliojs/pdfkit#1096). The font `embedForAcroForm()`
   * builds is a complete, non-subsetted, standard-encoding font instead, so
   * a reader can resolve arbitrary field text against it on its own.
   */
  acroFormRef() {
    return this.acroFormDictionary != null
      ? this.acroFormDictionary
      : (this.acroFormDictionary = this.document.ref());
  }

  finalize() {
    if (this.embedded) {
      return;
    }
    if (this.dictionary != null) {
      this.embed();
    }
    if (this.acroFormDictionary != null) {
      this.embedForAcroForm();
    }
    this.embedded = true;
  }

  embed() {
    const isCFF = this.subset.cff != null;
    const fontFile = this.document.ref();

    if (isCFF) {
      fontFile.data.Subtype = 'CIDFontType0C';
    }

    fontFile.end(this.subset.encode());

    const familyClass =
      ((this.font['OS/2'] != null
        ? this.font['OS/2'].sFamilyClass
        : undefined) || 0) >> 8;
    let flags = 0;
    if (this.font.post.isFixedPitch) {
      flags |= 1 << 0;
    }
    if (1 <= familyClass && familyClass <= 7) {
      flags |= 1 << 1;
    }
    flags |= 1 << 2; // assume the font uses non-latin characters
    if (familyClass === 10) {
      flags |= 1 << 3;
    }
    if (this.font.head.macStyle.italic) {
      flags |= 1 << 6;
    }

    // generate a tag (6 uppercase letters. 17 is the char code offset from '0' to 'A'. 73 will map to 'Z')
    const tag = [1, 2, 3, 4, 5, 6]
      .map((i) => String.fromCharCode((this.id.charCodeAt(i) || 73) + 17))
      .join('');
    const name = tag + '+' + this.font.postscriptName?.replaceAll(' ', '_');

    const { bbox } = this.font;
    const descriptor = this.document.ref({
      Type: 'FontDescriptor',
      FontName: name,
      Flags: flags,
      FontBBox: [
        bbox.minX * this.scale,
        bbox.minY * this.scale,
        bbox.maxX * this.scale,
        bbox.maxY * this.scale,
      ],
      ItalicAngle: this.font.italicAngle,
      Ascent: this.ascender,
      Descent: this.descender,
      CapHeight: (this.font.capHeight || this.font.ascent) * this.scale,
      XHeight: (this.font.xHeight || 0) * this.scale,
      StemV: 0,
    }); // not sure how to calculate this

    if (isCFF) {
      descriptor.data.FontFile3 = fontFile;
    } else {
      descriptor.data.FontFile2 = fontFile;
    }

    if (this.document.subset && this.document.subset === 1) {
      const maxCID = this.widths.length - 1;
      const cidSetBuffer = new Uint8Array(Math.ceil((maxCID + 1) / 8));
      for (let cid = 0; cid <= maxCID; cid++) {
        if (this.widths[cid] != null) {
          cidSetBuffer[Math.floor(cid / 8)] |= 0x80 >> (cid % 8);
        }
      }
      const CIDSetRef = this.document.ref();
      CIDSetRef.write(cidSetBuffer);
      CIDSetRef.end();

      descriptor.data.CIDSet = CIDSetRef;
    }

    descriptor.end();

    const descendantFontData = {
      Type: 'Font',
      Subtype: 'CIDFontType0',
      BaseFont: name,
      CIDSystemInfo: {
        Registry: new String('Adobe'),
        Ordering: new String('Identity'),
        Supplement: 0,
      },
      FontDescriptor: descriptor,
      W: [0, this.widths],
    };

    if (!isCFF) {
      descendantFontData.Subtype = 'CIDFontType2';
      descendantFontData.CIDToGIDMap = 'Identity';
    }

    const descendantFont = this.document.ref(descendantFontData);

    descendantFont.end();

    this.dictionary.data = {
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: name,
      Encoding: 'Identity-H',
      DescendantFonts: [descendantFont],
      ToUnicode: this.toUnicodeCmap(),
    };

    return this.dictionary.end();
  }

  /**
   * Embeds a second, standalone font for AcroForm use: a composite font
   * holding every glyph, addressed through a custom WinAnsiEncoding-to-glyph
   * CMap instead of the usual `/Identity-H`. See `acroFormRef()` for why
   * this exists separately from `embed()`, and `winAnsiToGidCmap()` for why
   * it's a composite font with a custom `/Encoding` rather than a simple
   * font with `/Encoding /WinAnsiEncoding`.
   */
  embedForAcroForm() {
    const isCFF = this.subset.cff != null;

    // Build a subset that includes every glyph rather than embedding the
    // font's own program buffer untouched: a reader must be able to resolve
    // *any* character a user later types into the field, not just the ones
    // already drawn elsewhere in the document, so it can't be a subset in
    // pdfkit's usual sense. This still goes through the ordinary subset
    // encoder (not the font's raw bytes) because the source font may be a
    // WOFF/WOFF2 file, whose raw bytes are a compressed container rather
    // than a valid standalone TrueType/CFF program; fontkit's subset encoder
    // already normalizes any source format into one.
    //
    // Because every glyph is included in ascending order, the subset's own
    // renumbering (fontkit's `Subset#includeGlyph`) assigns each glyph the
    // same id it already had in `this.font`, so the ids used below to build
    // the encoding and widths still apply directly to this font program.
    const fullSubset = this.font.createSubset();
    for (let gid = 0; gid < this.font.numGlyphs; gid++) {
      fullSubset.includeGlyph(gid);
    }
    const fontProgram = fullSubset.encode();

    const fontFile = this.document.ref();
    if (isCFF) {
      fontFile.data.Subtype = 'CIDFontType0C';
    } else {
      // Required for FontFile2 (spec 9.9, Table 127): the length in bytes of
      // the uncompressed TrueType program. Without it, Acrobat's forms
      // engine reports the font as one it "could not be extracted" when it
      // loads it to regenerate this field's appearance.
      fontFile.data.Length1 = fontProgram.length;
    }
    fontFile.end(fontProgram);

    const familyClass =
      ((this.font['OS/2'] != null
        ? this.font['OS/2'].sFamilyClass
        : undefined) || 0) >> 8;
    let flags = 0;
    if (this.font.post.isFixedPitch) {
      flags |= 1 << 0;
    }
    if (1 <= familyClass && familyClass <= 7) {
      flags |= 1 << 1;
    }
    flags |= 1 << 2; // assume the font uses non-latin characters, as embed() does
    if (this.font.head.macStyle.italic) {
      flags |= 1 << 6;
    }

    // This font program isn't a subset in pdfkit's usual sense (it holds
    // every glyph, not just the ones used so far), so, unlike `embed()`, its
    // name must not use the subset-tag convention (a six-uppercase-letter
    // prefix meaning "an arbitrary subset of the font named after the +",
    // spec 9.6.4). Reusing that tag previously gave both fonts the same
    // `/BaseFont` name despite different font programs, which is what caused
    // Acrobat to report the font this method builds as one it "could not be
    // extracted".
    const name = this.font.postscriptName?.replaceAll(' ', '_');

    const { bbox } = this.font;
    const descriptor = this.document.ref({
      Type: 'FontDescriptor',
      FontName: name,
      Flags: flags,
      FontBBox: [
        bbox.minX * this.scale,
        bbox.minY * this.scale,
        bbox.maxX * this.scale,
        bbox.maxY * this.scale,
      ],
      ItalicAngle: this.font.italicAngle,
      Ascent: this.ascender,
      Descent: this.descender,
      CapHeight: (this.font.capHeight || this.font.ascent) * this.scale,
      XHeight: (this.font.xHeight || 0) * this.scale,
      StemV: 0,
    });

    if (isCFF) {
      descriptor.data.FontFile3 = fontFile;
    } else {
      descriptor.data.FontFile2 = fontFile;
    }

    descriptor.end();

    // One width per glyph id, matching the font program above (which holds
    // every glyph, not only the WinAnsiEncoding-representable ones).
    const widths = [];
    for (let gid = 0; gid < this.font.numGlyphs; gid++) {
      widths.push(this.font.getGlyph(gid).advanceWidth * this.scale);
    }

    const descendantFontData = {
      Type: 'Font',
      Subtype: isCFF ? 'CIDFontType0' : 'CIDFontType2',
      BaseFont: name,
      CIDSystemInfo: {
        Registry: new String('Adobe'),
        Ordering: new String('Identity'),
        Supplement: 0,
      },
      FontDescriptor: descriptor,
      W: [0, widths],
    };
    if (!isCFF) {
      descendantFontData.CIDToGIDMap = 'Identity';
    }

    const descendantFont = this.document.ref(descendantFontData);
    descendantFont.end();

    this.acroFormDictionary.data = {
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: name,
      Encoding: this.winAnsiToGidCmap(),
      DescendantFonts: [descendantFont],
    };

    return this.acroFormDictionary.end();
  }

  /**
   * Builds an embedded CMap mapping each single-byte WinAnsiEncoding code to
   * the id of the glyph it represents (which are the same numbers as CIDs
   * here, see `embedForAcroForm()`), for use as that method's Type0 font's
   * `/Encoding` in place of a standard name such as `/Identity-H`.
   *
   * `Identity-H` only works when the content stream author already knows
   * which glyph id corresponds to each character, which is exactly the
   * capability a reader regenerating a field's appearance from its
   * plain-text value doesn't have -- and fontkit's subset encoder never
   * retains the font's own cmap or glyph-name tables that a reader could
   * otherwise have used, no matter how many glyphs a subset includes
   * (composite fonts, which is all pdfkit ever produces elsewhere, never
   * need them, so the encoder doesn't build them). This gives a reader a
   * character encoding to resolve field text against on its own anyway,
   * without depending on either.
   */
  winAnsiToGidCmap() {
    const cmap = this.document.ref();
    cmap.data.Type = 'CMap';

    const entries = [];
    for (let code = FIRST_WIN_ANSI_CHAR; code <= LAST_WIN_ANSI_CHAR; code++) {
      const codePoint = unicodeForWinAnsiCode(code);
      if (codePoint == null || !this.font.hasGlyphForCodePoint(codePoint)) {
        continue;
      }
      const gid = this.font.glyphForCodePoint(codePoint).id;
      entries.push(`<${code.toString(16).padStart(2, '0')}> ${gid}`);
    }

    const chunkSize = 100;
    const chunks = Math.ceil(entries.length / chunkSize);
    const ranges = [];
    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize, entries.length);
      ranges.push(
        `${end - start} begincidchar\n${entries.slice(start, end).join('\n')}\nendcidchar`,
      );
    }

    cmap.end(`\
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (Identity)
  /Supplement 0
>> def
/CMapName /Adobe-Identity-WinAnsi def
/CMapType 1 def
1 begincodespacerange
<20> <ff>
endcodespacerange
${ranges.join('\n')}
endcmap
CMapName currentdict /CMap defineresource pop
end
end\
`);

    return cmap;
  }

  // Maps the glyph ids encoded in the PDF back to unicode strings
  // Because of ligature substitutions and the like, there may be one or more
  // unicode characters represented by each glyph.
  toUnicodeCmap() {
    const cmap = this.document.ref();

    const entries = [];
    for (let codePoints of this.unicode) {
      const encoded = [];

      // encode codePoints to utf16
      for (let value of codePoints) {
        if (value > 0xffff) {
          value -= 0x10000;
          encoded.push(toHex(((value >>> 10) & 0x3ff) | 0xd800));
          value = 0xdc00 | (value & 0x3ff);
        }

        encoded.push(toHex(value));
      }

      entries.push(`<${encoded.join(' ')}>`);
    }

    const chunkSize = 256;
    const chunks = Math.ceil(entries.length / chunkSize);
    const ranges = [];
    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize, entries.length);
      ranges.push(
        `<${toHex(start)}> <${toHex(end - 1)}> [${entries.slice(start, end).join(' ')}]`,
      );
    }

    cmap.end(`\
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000><ffff>
endcodespacerange
${ranges.length} beginbfrange
${ranges.join('\n')}
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end\
`);

    return cmap;
  }
}

export default EmbeddedFont;
