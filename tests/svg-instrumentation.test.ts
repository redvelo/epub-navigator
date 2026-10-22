import { describe, expect, it } from "vitest";
import { instrumentSvg } from "../src/svg-instrumentation.js";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("SVG response instrumentation", () => {
  it("inserts a namespace-correct classic external script as the first root child", () => {
    const source = encode(
      `<?xml anything?><!-- <svg/> --><!DOCTYPE\nsvg \t><svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<svg/>]]><title>x</title></svg>`,
    );
    const transformed = instrumentSvg(source, { contentAgentUrl: "/content-agent.js" });

    expect(decode(transformed)).toContain(
      `<svg xmlns="http://www.w3.org/2000/svg"><script xmlns="http://www.w3.org/2000/svg" href="/content-agent.js"></script><![CDATA[<svg/>]]>`,
    );
  });

  it("accepts a prefixed SVG root and escapes hostile injected attributes", () => {
    const transformed = instrumentSvg(
      encode(`<s:svg data-hostile="&quot;&gt;&lt;" xmlns:s="http://www.w3.org/2000/svg"></s:svg>`),
      {
        contentAgentUrl: `/agent?one=1&two="2"<'`,
        nestedPublicationBaseUrl: `https://nested.example/?one="<&`,
        nonce: `nonce<&>"'\n`,
      },
    );

    expect(decode(transformed)).toContain(
      `<script xmlns="http://www.w3.org/2000/svg" href="/agent?one=1&amp;two=&quot;2&quot;&lt;&apos;" data-epub-navigator-nested-publication-base-url="https://nested.example/?one=&quot;&lt;&amp;" nonce="nonce&lt;&amp;&gt;&quot;&apos;&#xA;"></script>`,
    );
  });

  it("preserves the BOM and every authored byte around the insertion", () => {
    const before = encode(
      `<?xml version='1.0'?><svg  xmlns='http://www.w3.org/2000/svg' data-x='a&amp;b'>`,
    );
    const after = encode(`\r\n<!-- authored --><path d='M0 0'/></svg>`);
    const source = new Uint8Array(3 + before.length + after.length);
    source.set([0xef, 0xbb, 0xbf]);
    source.set(before, 3);
    source.set(after, 3 + before.length);

    const transformed = instrumentSvg(source, { contentAgentUrl: "/agent.js" });
    expect(transformed.slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(transformed.slice(3, 3 + before.length)).toEqual(before);
    expect(transformed.slice(transformed.length - after.length)).toEqual(after);
    expect(source).toEqual(new Uint8Array([0xef, 0xbb, 0xbf, ...before, ...after]));
  });

  it("stops scanning after the complete SVG root start tag", () => {
    const suffix = `<script>publisher()</script><g title="&publisher;">\0</wrong>`;
    const source = `<svg xmlns="http://www.w3.org/2000/svg" data-value=">">${suffix}`;

    expect(decode(instrumentSvg(encode(source), { contentAgentUrl: "/agent.js" }))).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" data-value=">"><script xmlns="http://www.w3.org/2000/svg" href="/agent.js"></script>${suffix}`,
    );
  });

  it("rejects unsafe documents before returning any transformed bytes", () => {
    for (const [name, document, code] of [
      ["wrong namespace", `<svg xmlns="urn:not-svg"></svg>`, "root is not svg"],
      ["unbound root prefix", `<s:svg></s:svg>`, "root is not svg"],
      ["missing root", `<?xml anything?><!-- only a comment -->`, "no root element"],
      [
        "wrong doctype keyword case",
        `<!doctype svg><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
        "unsupported declaration",
      ],
      ["self-closing root", `<svg xmlns="http://www.w3.org/2000/svg"/>`, "root is self-closing"],
      [
        "XSLT stylesheet by declared type",
        `<?xml-stylesheet type="text/xsl" href="t.xsl"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
        "XSLT stylesheet would replace the document",
      ],
      [
        "XSLT stylesheet by href alone",
        `<?xml-stylesheet href="transform.xsl"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
        "XSLT stylesheet would replace the document",
      ],
      [
        "unterminated DOCTYPE internal subset",
        `<!DOCTYPE svg [<!ENTITY probe "x"><svg xmlns="http://www.w3.org/2000/svg"></svg>`,
        "doctype declaration is unterminated",
      ],
      [
        "hostile fake root attribute",
        `<x a="<svg xmlns='http://www.w3.org/2000/svg'>"></x>`,
        "root is not svg",
      ],
    ] as const) {
      expect(
        () => instrumentSvg(encode(document), { contentAgentUrl: "/agent.js" }),
        name,
      ).toThrowError(code);
    }
  });

  it("serves what the browser's own XML parser adjudicates", () => {
    const root = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
    for (const document of [
      `<!DOCTYPE svg [<!ENTITY probe "x">]>${root}`,
      `<!DOCTYPE svg PUBLIC "id" "about:blank" [<!ENTITY probe "x">]>${root}`,
      `<!DOCTYPE svg PUBLIC "id">${root}`,
      `<!DOCTYPE html>${root}`,
      `<!DOCTYPE SVG>${root}`,
      `<?xml-stylesheet type="text/css" href="style.css"?>${root}`,
      `<svg xmlns="http://www.w3.org/2000/svg" title="&publisher;"></svg>`,
    ]) {
      const instrumented = instrumentSvg(encode(document), { contentAgentUrl: "/agent.js" });
      expect(new TextDecoder().decode(instrumented), document).toContain("/agent.js");
    }
  });

  it("rejects invalid UTF-8 and invalid injected XML characters", () => {
    expect(() =>
      instrumentSvg(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0xff]), {
        contentAgentUrl: "/agent.js",
      }),
    ).toThrowError("the SVG document is not valid UTF-8");
    expect(() =>
      instrumentSvg(encode(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), {
        contentAgentUrl: "/agent\0.js",
      }),
    ).toThrowError("an injected SVG attribute contains an invalid XML character");
  });
});
