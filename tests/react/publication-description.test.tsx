// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationDescription } from "../../src/react/publication-description.js";

afterEach(cleanup);

it("renders description formatting without importing executable elements or attributes", () => {
  const onLinkActivation = vi.fn();
  const { container } = render(
    <PublicationDescription
      direction={null}
      onLinkActivation={onLinkActivation}
      markup={`
    <h2 style="position:fixed">About this book</h2>
    <p onclick="alert(1)">An <strong>illustrated</strong> &amp; <em>annotated</em> edition.</p>
    <ul><li>First feature</li></ul>
    <a href="https://example.com/book" target="_top" onmouseover="alert(1)">Publisher</a>
    <a href="javascript:alert(1)">Unsafe link</a>
    <script>alert(1)</script><style>body { display:none }</style>
    <iframe src="https://example.com"></iframe><img src="https://example.com/tracker" onerror="alert(1)">
    <svg><script>alert(1)</script></svg><form><input autofocus></form>
  `}
    />,
  );
  expect(screen.getByRole("heading", { name: "About this book" }).tagName).toBe("H4");
  expect(container.querySelector("strong")?.textContent).toBe("illustrated");
  expect(container.querySelector("em")?.textContent).toBe("annotated");
  expect(screen.getByRole("listitem").textContent).toBe("First feature");
  expect(
    container.querySelector(
      "script, style, iframe, img, svg, form, input, [style], [onclick], [onmouseover], [target]",
    ),
  ).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  const link = screen.getByRole("link", { name: "Publisher" });
  expect(link.getAttribute("href")).toBe("https://example.com/book");
  expect(fireEvent.click(link)).toBe(false);
  expect(onLinkActivation).not.toHaveBeenCalled();
});

it("keeps plain descriptions and link text readable without a host link handler", () => {
  const { container } = render(
    <PublicationDescription
      direction={null}
      onLinkActivation={undefined}
      markup={
        'A plain description &amp; more. <a href="https://example.com">Publisher</a> <a href="../chapter.xhtml">Chapter</a>'
      }
    />,
  );
  expect(container.textContent).toBe("A plain description & more. Publisher Chapter");
  expect(screen.queryByRole("link")).toBeNull();
});
