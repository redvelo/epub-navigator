import type { ReactNode } from "react";
import {
  BookOpen,
  Keyboard,
  Library,
  Maximize,
  Minimize,
  Minus,
  Plus,
  Settings,
} from "lucide-react";
import type { PublicationTheme, PublicationTypeface } from "../../generated/kernel.js";
import { Button } from "../components/ui/button.js";
import { ButtonGroup, ButtonGroupText } from "../components/ui/button-group.js";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group.js";
import { Switch } from "../components/ui/switch.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import {
  isPreferenceValue,
  navigatorReaderPreferenceValues,
} from "../../runtime/preference-values.js";
import { cn, titleCase } from "../lib/utils.js";
import type { PreferencesSetter } from "../runtime/preferences.js";
import { useHoverAvailable, useTouchAvailable } from "../workspace/responsive.js";
import type { NavigatorReaderPreferences } from "../public-types.js";

const fontScaleValues = ["80", "90", "100", "110", "125", "140", "160", "200"] as const;

export function CompactQuickMenu({
  preferences,
  setPreferences,
  fullscreen,
  fullscreenAvailable,
  onFullscreen,
  onSettings,
  onKeyboardShortcuts,
  onPublicationDetails,
  onLibraryRequest,
  paginated = false,
  onZoomAdjustment,
  additionalControls,
}: {
  readonly preferences: NavigatorReaderPreferences;
  readonly setPreferences: PreferencesSetter;
  readonly fullscreen: boolean;
  readonly fullscreenAvailable: boolean;
  readonly onFullscreen: () => void;
  readonly onSettings: () => void;
  readonly onKeyboardShortcuts?: (() => void) | undefined;
  readonly onPublicationDetails?: (() => void) | undefined;
  readonly onLibraryRequest?: (() => void) | undefined;
  readonly paginated?: boolean | undefined;
  readonly onZoomAdjustment?: (() => void) | undefined;
  readonly additionalControls?: ReactNode | undefined;
}) {
  const fontIndex = fontScaleValues.indexOf(preferences.fontScale);
  const setFontIndex = (index: number) => {
    const fontScale = fontScaleValues[Math.min(fontScaleValues.length - 1, Math.max(0, index))];
    if (fontScale !== undefined) setPreferences((current) => ({ ...current, fontScale }));
  };
  return (
    <div className={cn("grid gap-4 p-4", !paginated && "overflow-y-auto")}>
      <CompactSettingLabel label="Text size" className="epub-navigator-reader__quick-text-size">
        <ButtonGroup
          className="epub-navigator-reader__stepper grid w-full grid-cols-[2.75rem_1fr_2.75rem] items-center rounded-xl bg-muted"
          aria-label="Text size"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-11"
            aria-label="Decrease text size"
            disabled={fontIndex <= 0}
            onClick={() => setFontIndex(fontIndex - 1)}
          >
            <Minus aria-hidden="true" />
          </Button>
          <ButtonGroupText className="epub-navigator-reader__stepper-value justify-center rounded-none bg-transparent px-0">
            <output className="text-center tabular-nums">{preferences.fontScale}%</output>
          </ButtonGroupText>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-11"
            aria-label="Increase text size"
            disabled={fontIndex >= fontScaleValues.length - 1}
            onClick={() => setFontIndex(fontIndex + 1)}
          >
            <Plus aria-hidden="true" />
          </Button>
        </ButtonGroup>
      </CompactSettingLabel>
      <CompactSettingLabel label="Book colors" className="epub-navigator-reader__quick-colors">
        <BookColorOptions
          value={preferences.publicationTheme}
          onChange={(publicationTheme) =>
            setPreferences((current) => ({ ...current, publicationTheme }))
          }
          ariaLabel="Book colors"
        />
      </CompactSettingLabel>
      <CompactSettingLabel label="Layout" className="epub-navigator-reader__quick-presentation">
        <ToggleGroup
          value={[preferences.presentationMode]}
          onValueChange={(values) => {
            const presentationMode = values[0];
            if (isPreferenceValue("presentationMode", presentationMode)) {
              setPreferences((current) => ({ ...current, presentationMode }));
            }
          }}
          spacing={0}
          className="epub-navigator-reader__quick-layout grid w-full grid-cols-3 rounded-2xl bg-muted"
          aria-label="Layout"
        >
          {navigatorReaderPreferenceValues.presentationMode.map((presentationMode) => (
            <ToggleGroupItem
              key={presentationMode}
              value={presentationMode}
              className="min-h-11 w-full"
            >
              {presentationModeLabel(presentationMode)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CompactSettingLabel>
      {onZoomAdjustment === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-11"
          onClick={onZoomAdjustment}
        >
          Adjust fixed-page zoom
        </Button>
      )}
      {additionalControls}
      {fullscreenAvailable ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-11"
          onClick={onFullscreen}
        >
          {fullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
          {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        </Button>
      ) : null}
      {onPublicationDetails === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-11"
          onClick={onPublicationDetails}
        >
          <BookOpen aria-hidden="true" />
          Publication
        </Button>
      )}
      {onKeyboardShortcuts === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="relative min-h-11"
          onClick={onKeyboardShortcuts}
        >
          <Keyboard aria-hidden="true" />
          Keyboard shortcuts
          {/* The hint sits at the edge without taking the row's slack, which an auto margin
              would, leaving the icon and label pushed off the centre every other action keeps. */}
          {preferences.keyboardMode === "off" ? null : (
            <kbd className="absolute end-4 text-xs text-muted-foreground" aria-hidden="true">
              ?
            </kbd>
          )}
        </Button>
      )}
      <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={onSettings}>
        <Settings aria-hidden="true" />
        Settings
      </Button>
      {onLibraryRequest === undefined ? null : (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="min-h-11"
          onClick={onLibraryRequest}
        >
          <Library aria-hidden="true" />
          Library
        </Button>
      )}
    </div>
  );
}

function CompactSettingLabel({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className={cn("grid gap-2", className)}>
      <h3 className="m-0 text-xs font-semibold tracking-wider uppercase">{label}</h3>
      {children}
    </section>
  );
}

export function ReadingSettings({
  preferences,
  setPreferences,
  readerTypefaces,
  paginated = false,
  deviceControls,
}: {
  readonly preferences: NavigatorReaderPreferences;
  readonly setPreferences: PreferencesSetter;
  readonly readerTypefaces: readonly PublicationTypeface[];
  readonly paginated?: boolean | undefined;
  readonly deviceControls?: ReactNode | undefined;
}) {
  const touchAvailable = useTouchAvailable();
  const hoverPointer = useHoverAvailable();
  return (
    <div className={cn("epub-navigator-reader__settings", !paginated && "overflow-y-auto")}>
      <SettingsSection id="settings-appearance" label="Appearance">
        <SettingsSegmentedChoice
          id="settings-interface-colors"
          label="Interface colors"
          value={preferences.colorScheme}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(colorScheme) => setPreferences((current) => ({ ...current, colorScheme }))}
        />
        <BookColorChoice
          value={preferences.publicationTheme}
          onChange={(publicationTheme) =>
            setPreferences((current) => ({ ...current, publicationTheme }))
          }
        />
        {readerTypefaces.length > 0 ? (
          <SettingsSegmentedChoice
            id="settings-typeface"
            label="Typeface"
            value={preferences.publicationTypeface}
            options={[
              { value: "original", label: "Original" },
              ...readerTypefaces.map((typeface) => ({
                value: typeface,
                label: typeface === "reader-serif" ? "Reader Serif" : "Reader Sans",
              })),
            ]}
            onChange={(publicationTypeface) =>
              setPreferences((current) => ({ ...current, publicationTypeface }))
            }
          />
        ) : null}
        <SettingsStepper
          label="Text size"
          value={preferences.fontScale}
          values={fontScaleValues}
          format={(value) => `${value}%`}
          onChange={(fontScale) => setPreferences((current) => ({ ...current, fontScale }))}
        />
        <SettingsSegmentedChoice
          id="settings-line-spacing"
          label="Line spacing"
          value={preferences.lineHeight}
          options={[
            { value: "original", label: "Original" },
            { value: "1.25", label: "1.25x" },
            { value: "1.5", label: "1.5x" },
            { value: "1.75", label: "1.75x" },
            { value: "2", label: "2x" },
          ]}
          description={lineSpacingDescription(preferences.lineHeight)}
          onChange={(lineHeight) => setPreferences((current) => ({ ...current, lineHeight }))}
        />
        <SettingsStepper
          label="Letter spacing"
          value={preferences.letterSpacing}
          values={["0", "0.03", "0.06", "0.12"]}
          format={(value) => `${Math.round(Number(value) * 100)}%`}
          onChange={(letterSpacing) => setPreferences((current) => ({ ...current, letterSpacing }))}
        />
        <SettingsStepper
          label="Word spacing"
          value={preferences.wordSpacing}
          values={["0", "0.04", "0.08", "0.16"]}
          format={(value) => `${Math.round(Number(value) * 100)}%`}
          onChange={(wordSpacing) => setPreferences((current) => ({ ...current, wordSpacing }))}
        />
      </SettingsSection>

      <SettingsSection id="settings-layout" label="Layout">
        <SettingsSegmentedChoice
          id="settings-presentation"
          label="Presentation"
          value={preferences.presentationMode}
          options={navigatorReaderPreferenceValues.presentationMode.map((value) => ({
            value,
            label: presentationModeLabel(value),
          }))}
          description={presentationModeDescription(preferences.presentationMode)}
          onChange={(presentationMode) =>
            setPreferences((current) => ({ ...current, presentationMode }))
          }
        />
        <SettingsSegmentedChoice
          id="settings-columns"
          label="Columns"
          value={preferences.paginationColumns}
          options={[
            { value: "auto", label: "Auto" },
            { value: "single", label: "Single" },
            { value: "double", label: "Double" },
          ]}
          disabled={preferences.presentationMode === "document-scroll"}
          description={
            preferences.presentationMode === "document-scroll"
              ? "Columns apply to paginated reading only."
              : undefined
          }
          onChange={(paginationColumns) =>
            setPreferences((current) => ({ ...current, paginationColumns }))
          }
        />
        <SettingsSegmentedChoice
          id="settings-width"
          label="Margins"
          value={preferences.measure}
          options={[
            { value: "full-width", label: "None" },
            { value: "wide", label: "Comfortable" },
            { value: "medium", label: "Wide" },
            { value: "narrow", label: "Widest" },
          ]}
          description={marginsDescription(preferences.measure)}
          onChange={(measure) => setPreferences((current) => ({ ...current, measure }))}
        />
        <SettingsSegmentedChoice
          id="settings-paragraph-spacing"
          label="Paragraph spacing"
          value={preferences.paragraphSpacing}
          options={[
            { value: "original", label: "Original" },
            { value: "0", label: "None" },
            { value: "1", label: "1x" },
            { value: "2", label: "2x" },
          ]}
          description={paragraphSpacingDescription(preferences.paragraphSpacing)}
          onChange={(paragraphSpacing) =>
            setPreferences((current) => ({ ...current, paragraphSpacing }))
          }
        />
        <SettingsSegmentedChoice
          id="settings-text-indent"
          label="First-line indent"
          value={preferences.textIndent}
          options={[
            { value: "original", label: "Original" },
            { value: "0", label: "None" },
            { value: "1", label: "1x" },
            { value: "2", label: "2x" },
          ]}
          description={textIndentDescription(preferences.textIndent)}
          onChange={(textIndent) => setPreferences((current) => ({ ...current, textIndent }))}
        />
        <SettingsSegmentedChoice
          id="settings-alignment"
          label="Alignment"
          value={preferences.alignment}
          options={[
            { value: "original", label: "Original" },
            { value: "start", label: "Start" },
            { value: "justify", label: "Justify" },
          ]}
          onChange={(alignment) => setPreferences((current) => ({ ...current, alignment }))}
        />
        <SettingsSegmentedChoice
          id="settings-hyphenation"
          label="Hyphenation"
          value={preferences.hyphenation}
          options={[
            { value: "original", label: "Original" },
            { value: "auto", label: "Auto" },
            { value: "off", label: "Off" },
          ]}
          onChange={(hyphenation) => setPreferences((current) => ({ ...current, hyphenation }))}
        />
      </SettingsSection>

      {deviceControls === undefined ? null : (
        <SettingsSection id="settings-device" label="Device">
          {deviceControls}
        </SettingsSection>
      )}

      {/* Each field answers for one kind of input, so it is offered only where that input is. */}
      {hoverPointer || touchAvailable ? (
        <SettingsSection id="settings-interaction" label="Interaction">
          {hoverPointer ? (
            <SettingsSwitchField
              id="settings-click"
              label="Click edges to turn pages"
              description="Use mouse clicks at the edges of the reading area to turn pages."
              checked={preferences.clickZones ?? false}
              onChange={(clickZones) => setPreferences((current) => ({ ...current, clickZones }))}
            />
          ) : null}
          {hoverPointer ? (
            <SettingsSegmentedChoice
              id="settings-keyboard"
              label="Keyboard"
              value={preferences.keyboardMode}
              options={[
                { value: "off", label: "Off" },
                { value: "standard", label: "Standard" },
                { value: "vim", label: "Vim" },
              ]}
              description={keyboardModeDescription(preferences.keyboardMode)}
              onChange={(keyboardMode) =>
                setPreferences((current) => ({ ...current, keyboardMode }))
              }
            />
          ) : null}
          {touchAvailable ? (
            <SettingsSwitchField
              id="settings-touch"
              label="Touch zones"
              description="Tap the left or right edge of the page to turn it."
              checked={preferences.touchZones}
              onChange={(touchZones) => setPreferences((current) => ({ ...current, touchZones }))}
            />
          ) : null}
        </SettingsSection>
      ) : null}
    </div>
  );
}

function SettingsSection({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="epub-navigator-reader__settings-section" aria-labelledby={id}>
      <h3 id={id}>{label}</h3>
      {children}
    </section>
  );
}

function SettingsField({
  id,
  label,
  description,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly children: ReactNode;
}) {
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  return (
    <div className="epub-navigator-reader__settings-field">
      <span id={id} className="epub-navigator-reader__settings-label">
        {label}
      </span>
      {children}
      {description === undefined ? null : (
        <p id={descriptionId} className="epub-navigator-reader__settings-description">
          {description}
        </p>
      )}
    </div>
  );
}

export function SettingsSegmentedChoice<const T extends string>({
  id,
  label,
  value,
  options,
  description,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onChange: (value: T) => void;
}) {
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  return (
    <SettingsField id={id} label={label} description={description}>
      <RadioGroup
        value={value}
        onValueChange={onChange}
        aria-labelledby={id}
        aria-describedby={descriptionId}
        aria-disabled={disabled || undefined}
        className="epub-navigator-reader__settings-segments"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <RadioGroupItem
            key={option.value}
            value={option.value}
            disabled={disabled}
            className="epub-navigator-reader__settings-segment"
          >
            {option.label}
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </SettingsField>
  );
}

function BookColorChoice({
  value,
  onChange,
}: {
  readonly value: PublicationTheme;
  readonly onChange: (value: PublicationTheme) => void;
}) {
  const id = "settings-book-colors";
  const descriptionId = `${id}-description`;
  return (
    <SettingsField id={id} label="Book colors" description={bookColorDescription(value)}>
      <BookColorOptions
        value={value}
        onChange={onChange}
        ariaLabelledBy={id}
        ariaDescribedBy={descriptionId}
      />
    </SettingsField>
  );
}

function BookColorOptions({
  value,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}: {
  readonly value: PublicationTheme;
  readonly onChange: (value: PublicationTheme) => void;
  readonly ariaLabel?: string | undefined;
  readonly ariaLabelledBy?: string | undefined;
  readonly ariaDescribedBy?: string | undefined;
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={onChange}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      className="epub-navigator-reader__settings-color-grid"
    >
      {(["auto", "original", "light", "dark"] as const).map((theme) => (
        <RadioGroupItem key={theme} value={theme} className="epub-navigator-reader__settings-color">
          <span
            className="epub-navigator-reader__settings-color-swatch"
            data-theme={theme}
            aria-hidden="true"
          />
          {titleCase(theme)}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}

function SettingsStepper<const T extends string>({
  label,
  value,
  values,
  format,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly values: readonly T[];
  readonly format: (value: T) => string;
  readonly onChange: (value: T) => void;
}) {
  const id = `settings-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <SettingsField id={id} label={label}>
      <ReaderStepper
        label={label}
        value={value}
        values={values}
        format={format}
        onChange={onChange}
      />
    </SettingsField>
  );
}

function ReaderStepper<const T extends string>({
  label,
  value,
  values,
  format,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly values: readonly T[];
  readonly format: (value: T) => string;
  readonly onChange: (value: T) => void;
}) {
  const index = Math.max(0, values.indexOf(value));
  const previous = values[index - 1];
  const next = values[index + 1];
  return (
    <ButtonGroup
      className="epub-navigator-reader__stepper grid w-full grid-cols-[2.75rem_1fr_2.75rem] items-center rounded-xl bg-muted"
      aria-label={label}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="size-11"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={previous === undefined}
        onClick={() => previous === undefined || onChange(previous)}
      >
        <Minus aria-hidden="true" />
      </Button>
      <ButtonGroupText className="epub-navigator-reader__stepper-value justify-center rounded-none bg-transparent px-0">
        <output className="text-center tabular-nums" aria-live="polite">
          {format(value)}
        </output>
      </ButtonGroupText>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="size-11"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={next === undefined}
        onClick={() => next === undefined || onChange(next)}
      >
        <Plus aria-hidden="true" />
      </Button>
    </ButtonGroup>
  );
}

function SettingsSwitchField({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;
  return (
    <div className="epub-navigator-reader__settings-switch-field">
      <span>
        <strong id={id}>{label}</strong>
        <small id={descriptionId}>{description}</small>
      </span>
      <Switch
        checked={checked}
        aria-labelledby={id}
        aria-describedby={descriptionId}
        className="after:-inset-x-3 after:-inset-y-3"
        onCheckedChange={onChange}
      />
    </div>
  );
}

function bookColorDescription(value: PublicationTheme): string {
  if (value === "auto") return "Match the interface.";
  if (value === "original") return "Keep the colors the book supplies.";
  if (value === "light") return "Show the book on a light background.";
  return "Show the book on a dark background.";
}

function presentationModeLabel(value: NavigatorReaderPreferences["presentationMode"]): string {
  if (value === "auto") return "Auto";
  return value === "paginated" ? "Paginated" : "Scrolled";
}

function presentationModeDescription(
  value: NavigatorReaderPreferences["presentationMode"],
): string {
  if (value === "auto") {
    return "Read each book the way it asks to be read, and paginate when it asks for nothing.";
  }

  if (value === "paginated") return "Turn one measured page at a time.";
  return "Scroll through a section; page turns move between sections.";
}

/**
 * Original is a mode, not a point on a scale: authored line height varies by element, so a
 * stepper's arrows could not order it. A choice promises no ordering, so it can hold both.
 */
function lineSpacingDescription(value: NavigatorReaderPreferences["lineHeight"]): string {
  if (value === "original") return "Keep the line height the book sets for each element.";
  return `Set every line to ${value} times the text size.`;
}

/** Margins are stated as margin, so a wider margin means a narrower line of text. */
function marginsDescription(value: NavigatorReaderPreferences["measure"]): string {
  if (value === "full-width") return "Let text fill the reading area.";
  return "Hold the line of text to a comfortable length.";
}

function paragraphSpacingDescription(
  value: NavigatorReaderPreferences["paragraphSpacing"],
): string {
  if (value === "original") return "Keep the spacing between paragraphs the book sets.";
  if (value === "0") return "Run paragraphs together, separated only by any indent.";
  return `Separate paragraphs by ${value} times the text size.`;
}

function textIndentDescription(value: NavigatorReaderPreferences["textIndent"]): string {
  if (value === "original") return "Keep the first-line indent the book sets.";
  if (value === "0") return "Start every paragraph at the margin.";
  return `Indent the first line by ${value} times the text size.`;
}

function keyboardModeDescription(value: NavigatorReaderPreferences["keyboardMode"]): string {
  if (value === "off") return "Let the book and the browser handle every key.";
  if (value === "standard")
    return "Use arrows, Page Up, Page Down, and Space to navigate. Press ? for shortcuts.";
  return "Add j/k page turns, h/l section navigation, and gg/G document navigation. Press ? for shortcuts.";
}
