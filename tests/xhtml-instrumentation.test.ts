import { describe, expect, it } from "vitest";
import { instrumentXhtml } from "../src/xhtml-instrumentation.js";

const namespace = "http://www.w3.org/1999/xhtml";
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

describe("XHTML response instrumentation", () => {
  it("finds a safe head insertion point in supported prologues", () => {
    for (const [name, document] of [
      ["attributes", `<html xmlns="${namespace}"><head profile="value"></head></html>`],
      [
        "namespace prefixes",
        `<x:html xmlns:x="${namespace}"><x:head><x:title>x</x:title></x:head></x:html>`,
      ],
      [
        "a namespace declared on head",
        `<x:html xmlns:x="${namespace}"><h:head xmlns:h="${namespace}"></h:head></x:html>`,
      ],
      ["quoted greater-than", `<html xmlns="${namespace}"><head data-value="a > b"></head></html>`],
      ["comment", `<html xmlns="${namespace}"><!-- <head> --><head></head></html>`],
      ["CDATA", `<html xmlns="${namespace}"><![CDATA[<head>]]><head></head></html>`],
      [
        "processing instruction",
        `<html xmlns="${namespace}"><?probe <head> ?><head></head></html>`,
      ],
      [
        "plain doctype with XML whitespace",
        `<!DOCTYPE\nhtml \t><html xmlns="${namespace}"><head></head></html>`,
      ],
      [
        "XHTML 1.1 public doctype",
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="${namespace}"><head></head><body>a&nbsp;b</body></html>`,
      ],
      [
        "XHTML 1.0 doctype with single quotes and newline",
        `<!DOCTYPE html PUBLIC '-//W3C//DTD XHTML 1.0 Strict//EN'\n  'http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd' ><html xmlns="${namespace}"><head></head></html>`,
      ],
      [
        "system doctype",
        `<!DOCTYPE html SYSTEM "about:legacy-compat"><html xmlns="${namespace}"><head></head></html>`,
      ],
      [
        "predefined and numeric entities",
        `<html xmlns="${namespace}" title="&amp;&#65;&#x41;"><head></head></html>`,
      ],
    ] as const) {
      const transformed = decode(
        instrumentXhtml(encode(document), { contentAgentUrl: "/content-agent.js" }),
      );
      expect(transformed, name).toContain(
        `<script xmlns="${namespace}" src="/content-agent.js"></script>`,
      );
      expect(transformed.indexOf("content-agent.js"), name).toBeGreaterThan(
        document.indexOf("<head"),
      );
      expect(transformed.indexOf("content-agent.js"), name).toBeLessThan(
        transformed.lastIndexOf("head>"),
      );
    }
  });

  it("uses root and direct-child namespaces without inheriting nested declarations", () => {
    const document = `<x:html xmlns:x="${namespace}" xmlns:f="urn:foreign"><f:section xmlns:x="urn:nested"><x:head /></f:section><x:head></x:head></x:html>`;
    const transformed = decode(instrumentXhtml(encode(document), { contentAgentUrl: "/agent.js" }));

    expect(transformed).toContain(`<x:head><script xmlns="${namespace}" src="/agent.js"></script>`);
    expect(transformed.indexOf("/agent.js")).toBeGreaterThan(transformed.indexOf("<x:head />"));
  });

  it("stops scanning after the complete head start tag", () => {
    const suffix = `<script>publisher()</script><body unknown="&publisher;">\0</wrong>`;
    const document = `<html xmlns="${namespace}"><head data-value=">">${suffix}`;
    const transformed = decode(instrumentXhtml(encode(document), { contentAgentUrl: "/agent.js" }));

    expect(transformed).toBe(
      `<html xmlns="${namespace}"><head data-value=">"><script xmlns="${namespace}" src="/agent.js"></script>${suffix}`,
    );
  });

  it("escapes attributes and orders the stylesheet before the agent", () => {
    const transformed = decode(
      instrumentXhtml(encode(`<html xmlns="${namespace}"><head></head></html>`), {
        contentAgentUrl: '/agent?one=1&two="2"',
        nestedPublicationBaseUrl: 'https://nested.example/?one="<&',
        readerFontStylesheetUrl: "/font?<>&\"'",
        nonce: `nonce<&>"'\n`,
      }),
    );
    expect(transformed).toContain(
      'href="/font?&lt;&gt;&amp;&quot;&apos;" data-epub-navigator-reader-font="reader-serif"',
    );
    expect(transformed).toContain(
      'src="/agent?one=1&amp;two=&quot;2&quot;" data-epub-navigator-nested-publication-base-url="https://nested.example/?one=&quot;&lt;&amp;" nonce="nonce&lt;&amp;&gt;&quot;&apos;&#xA;"',
    );
    expect(transformed.indexOf("<link")).toBeLessThan(transformed.indexOf("<script"));
  });

  it("preserves the BOM and every authored byte around the insertion", () => {
    const before = encode(
      `<?xml anything?><x:html xmlns:x='${namespace}'><x:head data-title='café &amp; tea'>`,
    );
    const after = encode("\r\n<x:title>東京</x:title></x:head><x:body>naïve</x:body></x:html>");
    const source = new Uint8Array(3 + before.byteLength + after.byteLength);
    source.set([0xef, 0xbb, 0xbf]);
    source.set(before, 3);
    source.set(after, 3 + before.byteLength);
    const authored = source.slice();

    const transformed = instrumentXhtml(source, { contentAgentUrl: "/agent.js" });
    const injected = encode(`<script xmlns="${namespace}" src="/agent.js"></script>`);

    expect(source).toEqual(authored);
    expect(transformed.subarray(0, 3 + before.byteLength)).toEqual(
      authored.subarray(0, 3 + before.byteLength),
    );
    expect(
      transformed.subarray(3 + before.byteLength, 3 + before.byteLength + injected.byteLength),
    ).toEqual(injected);
    expect(transformed.subarray(3 + before.byteLength + injected.byteLength)).toEqual(after);
  });

  it("rejects unsafe insertion prefixes", () => {
    const cases: Array<[string, string, string]> = [
      ["root without a namespace", "<html><head></head></html>", "root is not html"],
      [
        "root in the wrong namespace",
        '<html xmlns="urn:not-xhtml"><head></head></html>',
        "root is not html",
      ],
      ["wrong root local name", `<body xmlns="${namespace}"></body>`, "root is not html"],
      ["missing root", "<?probe value?><!-- comment -->", "has no root"],
      ["self-closing root", `<html xmlns="${namespace}" />`, "root is self-closing"],
      [
        "head in the wrong namespace",
        `<html xmlns="${namespace}"><head xmlns="urn:foreign"></head></html>`,
        "no direct head element",
      ],
      [
        "nested XHTML head",
        `<html xmlns="${namespace}"><body><head></head></body></html>`,
        "no direct head element",
      ],
      ["missing head", `<html xmlns="${namespace}"><body /></html>`, "no direct head element"],
      ["self-closing head", `<html xmlns="${namespace}"><head /></html>`, "head is self-closing"],
      [
        "script before head",
        `<html xmlns="${namespace}"><script></script><head></head></html>`,
        "script element precedes",
      ],
      [
        "nested foreign script before head",
        `<html xmlns="${namespace}" xmlns:f="urn:f"><f:aside><f:script /></f:aside><head></head></html>`,
        "script element precedes",
      ],
      [
        "wrong doctype keyword case",
        `<!doctype html><html xmlns="${namespace}"><head></head></html>`,
        "unsupported declaration",
      ],
      [
        "XSLT stylesheet by declared type",
        `<?xml-stylesheet type="text/xsl" href="t.xsl"?><html xmlns="${namespace}"><head></head></html>`,
        "XSLT stylesheet would replace the document",
      ],
      [
        "XSLT stylesheet by href alone",
        `<?xml-stylesheet href="transform.xsl"?><html xmlns="${namespace}"><head></head></html>`,
        "XSLT stylesheet would replace the document",
      ],
      [
        "unterminated DOCTYPE internal subset",
        `<!DOCTYPE html [<!ENTITY probe "x"><html xmlns="${namespace}"><head /></html>`,
        "doctype declaration is unterminated",
      ],
      [
        "reserved namespace rebinding",
        `<xml:html xmlns:xml="${namespace}"><xml:head></xml:head></xml:html>`,
        "root is not html",
      ],
      [
        "unterminated comment before head",
        `<html xmlns="${namespace}"><!-- comment<head></head></html>`,
        "unterminated --> structure",
      ],
      [
        "unterminated CDATA before head",
        `<html xmlns="${namespace}"><![CDATA[x<head></head></html>`,
        "unterminated ]]> structure",
      ],
      [
        "unterminated attribute on head",
        `<html xmlns="${namespace}"><head title="value></head></html>`,
        "attribute value is unterminated",
      ],
    ];
    for (const [name, document, message] of cases) {
      expect(
        () => instrumentXhtml(encode(document), { contentAgentUrl: "/agent.js" }),
        name,
      ).toThrowError(message);
    }
  });

  it("serves what the browser's own XML parser adjudicates", () => {
    // Refusing these produced a 422 and a broken frame for documents a browser either renders or
    // reports itself. The internal entity subset and the non-XSLT stylesheet instruction are the
    // two that real publications actually use.
    const head = `<html xmlns="${namespace}"><head></head></html>`;
    const documents = [
      `<!DOCTYPE html [<!ENTITY nbsp "&#160;">]>${head}`,
      `<!DOCTYPE html PUBLIC "id" "about:blank" [<!ENTITY probe "x">]>${head}`,
      `<?xml-stylesheet type="application/vnd.adobe-page-template+xml" href="page-template.xpgt"?>${head}`,
      `<?xml-stylesheet type="text/css" href="style.css"?>${head}`,
      `<!DOCTYPE html PUBLIC "id">${head}`,
      `<!DOCTYPE html SYSTEM about:blank>${head}`,
      `<!DOCTYPE html SYSTEM "a<b">${head}`,
      `<!DOCTYPE svg>${head}`,
      `<!DOCTYPE HTML>${head}`,
      `<html xmlns="${namespace}">&publisher;<head></head></html>`,
      `<html xmlns="${namespace}">]]><head></head></html>`,
      `<html xmlns="${namespace}"><!-- one -- two --><head></head></html>`,
      `<html xmlns="${namespace}" title="&publisher;"><head></head></html>`,
      `text${head}`,
    ];
    for (const document of documents) {
      const instrumented = instrumentXhtml(encode(document), { contentAgentUrl: "/agent.js" });
      expect(new TextDecoder().decode(instrumented), document).toContain("/agent.js");
    }
  });

  it("reports descriptive errors for invalid input", () => {
    expect(() =>
      instrumentXhtml(new Uint8Array([0xff]), { contentAgentUrl: "/agent.js" }),
    ).toThrowError("the XHTML document is not valid UTF-8");
    expect(() =>
      instrumentXhtml(encode(`<html xmlns="${namespace}"><head></head></html>`), {
        contentAgentUrl: "/agent\0.js",
      }),
    ).toThrowError("an injected XHTML attribute contains an invalid XML character");
  });
});
