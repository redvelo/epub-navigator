import { expect, it } from "vitest";

it("keeps the intentional root source exports without loading the local WASM runtime", async () => {
  const entry = await import("../../src/index.js");

  expect(Object.keys(entry).sort()).toEqual([
    "DICTIONARY_SECTION_PAGE_SIZE",
    "MAX_DICTIONARY_QUERY_BYTES",
    "MAX_MEDIA_OVERLAY_AMBIGUOUS_CANDIDATES",
    "MAX_MEDIA_OVERLAY_ASSOCIATIONS",
    "MAX_MEDIA_OVERLAY_COLLECTION_ITEMS",
    "MAX_MEDIA_OVERLAY_COVERAGE_ENTRIES",
    "MAX_MEDIA_OVERLAY_DECLARATIONS",
    "MAX_MEDIA_OVERLAY_SEGMENTS",
    "MAX_MEDIA_OVERLAY_SEMANTIC_DEPTH",
    "MAX_MEDIA_OVERLAY_STRING_BYTES",
    "MAX_MEDIA_OVERLAY_TIMELINES",
    "MAX_MEDIA_OVERLAY_TOKENS_PER_NODE",
    "MAX_SEARCH_BATCH_BYTES",
    "MAX_SEARCH_CONTINUATION_BYTES",
    "MAX_SEARCH_EXCERPT_BYTES",
    "MAX_SEARCH_EXCERPT_CODE_POINTS",
    "MAX_SEARCH_ID_BYTES",
    "MAX_SEARCH_MESSAGE_BYTES",
    "MAX_SEARCH_QUERY_BYTES",
    "MAX_SEARCH_QUERY_CODE_POINTS",
    "MAX_SEARCH_RESOURCE_BYTES",
    "MAX_SEARCH_RESULTS_PER_BATCH",
    "MAX_SEARCH_SECTION_LABEL_BYTES",
    "MAX_SEARCH_TARGET_JSON_BYTES",
    "NAVIGATOR_DICTIONARY_RELATION_KINDS",
    "NavigatorError",
    "clipBeginMilliseconds",
    "decodePublicationRoute",
    "isNavigatorMediaOverlayAvailability",
    "isNavigatorMediaOverlayDescription",
    "isNavigatorMediaOverlayTimelineResult",
    "mediaOverlayAudioUrl",
    "mediaOverlayTimelineMatchesSummary",
    "navigatorDictionarySectionKey",
    "publicationResourceUrl",
    "smilClockMilliseconds",
  ]);
});

it("keeps the intentional runtime source exports", async () => {
  const entry = await import("../../src/runtime/index.js");

  expect(Object.keys(entry).sort()).toEqual([
    "CONTENT_AGENT_PROTOCOL_VERSION",
    "MEDIA_OVERLAY_RATES",
    "NavigatorDictionaryContractError",
    "NavigatorSearchContractError",
    "createNavigatorDictionaryCoordinator",
    "createNavigatorKernel",
    "createNavigatorMediaOverlayController",
    "createNavigatorRuntime",
    "createNavigatorSearchCoordinator",
    "isNavigatorMediaOverlayRate",
    "isPreferenceValue",
    "navigatorReaderPreferenceValues",
  ]);
});

it("keeps the intentional local source exports", async () => {
  const entry = await import("../../src/local/index.js");

  expect(Object.keys(entry).sort()).toEqual([
    "LocalHostError",
    "createBrowserLocalHost",
    "openLocalPublication",
  ]);
});

it("keeps the intentional React source exports", async () => {
  const entry = await import("../../src/react/index.js");

  expect(Object.keys(entry)).toEqual(["NavigatorReader"]);
});

it("keeps the intentional UI source exports", async () => {
  const entry = await import("../../src/ui/index.js");

  expect(Object.keys(entry).sort()).toEqual([
    "AddIcon",
    "Button",
    "CloseIcon",
    "Dialog",
    "DialogClose",
    "DialogContent",
    "DialogDescription",
    "DialogTitle",
    "Drawer",
    "DrawerClose",
    "DrawerContent",
    "DrawerDescription",
    "DrawerFooter",
    "DrawerHeader",
    "DrawerOverlay",
    "DrawerPortal",
    "DrawerTitle",
    "DrawerTrigger",
    "DropdownMenu",
    "DropdownMenuContent",
    "DropdownMenuItem",
    "DropdownMenuRadioGroup",
    "DropdownMenuRadioItem",
    "DropdownMenuSeparator",
    "DropdownMenuTrigger",
    "LampIcon",
    "NavigatorPaginatedOverflow",
    "NavigatorPaginationFooter",
    "NavigatorReadingSettings",
    "NavigatorSettingsChoice",
    "NavigatorTheme",
    "NextPageIcon",
    "Popover",
    "PopoverClose",
    "PopoverContent",
    "PopoverTitle",
    "PopoverTrigger",
    "PreviousPageIcon",
    "RadioGroup",
    "RadioGroupItem",
    "Separator",
    "Switch",
    "ToggleGroup",
    "ToggleGroupItem",
    "cn",
    "turnPaginatedSurface",
  ]);
});
