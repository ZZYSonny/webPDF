/**
 * The crop dropdown.
 *
 * Cropping a page to its content is the one thing in this reader that changes
 * what a document looks like, so it is opt-in twice over: it does nothing at
 * all until a pattern is checked, and every pattern can be switched on and off
 * individually. A rule is a name and a regular expression (`core/rules.ts`),
 * and the row says both: what a rule does is exactly the expression under it.
 *
 * The panel is a listbox of toggles rather than a set of checkboxes because it
 * lives in the same bar as the zoom menu and behaves like it: one dropdown open
 * at a time, arrow keys to move, Escape to leave. "Enable all" is the reference
 * script's own behaviour; "Disable all" is how a reader gets their page back.
 * The reader's own expressions are added at the foot of the list and removed
 * from the row itself, and they are kept for every document rather than this one
 * - a rule a reader writes is a rule.
 */

import {
  CROP_RULES,
  RECOMMENDED_RULE_ID,
  expandPattern,
  nextCustomId,
  ruleUsable,
  type CropRule,
  type CropRuleId,
} from './core/rules.ts';
import { normalisePatterns } from './core/crop.ts';
import { scrollIntoPanel } from './panels.ts';

export interface CropMenuOptions {
  button: HTMLButtonElement;
  menu: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  /**
   * The bulk pair. Exactly one of them is shown at a time: "Enable all" until
   * every rule that applies is checked, "Disable all" from there.
   */
  allButton: HTMLButtonElement;
  noneButton: HTMLButtonElement;
  /** The padding field, in page units. */
  padding: HTMLInputElement;
  /** The form a reader adds their own rule through. */
  add: {
    form: HTMLFormElement;
    name: HTMLInputElement;
    pattern: HTMLInputElement;
    error: HTMLElement;
  };
  /** The reader's own rules, as storage had them. */
  customRules?: readonly CropRule[];
  /** The reader's own rules changed: keep them. */
  onCustomRules?: (rules: readonly CropRule[]) => void;
  /** Ask the core whether a pattern compiles: an error message, or null. */
  checkPattern: (pattern: string) => Promise<string | null>;
  /** The selection, or the padding, changed: apply both. */
  onChange: (patterns: string[], padding: number) => void;
}

/** The most padding the field will take: two inches is already all margin. */
const MAX_PADDING = 144;

/**
 * The margin kept around the content, in page units, before anyone touches the
 * field. PaperCutter crops to the content exactly (0), which puts the box on
 * the ink: a hair of white - six points, a twelfth of an inch - is what stops a
 * trimmed page from looking cut off, and it is the value the panel starts on.
 */
const DEFAULT_PADDING = 6;

export interface CropProgress {
  measured: number;
  total: number;
  running: boolean;
}

export interface CropMenu {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** A document was opened: does the title rule have a title to work with? */
  setDocument(title: string): void;
  /** Measuring progress changed. */
  setProgress(state: CropProgress): void;
  /** The checked expressions, in list order - what the engine applies. */
  patterns(): string[];
  /** Check every rule, or none of them. */
  setAll(on: boolean): void;
  /**
   * Put the panel back where a reader left it: exactly these expressions, at
   * this padding.
   *
   * A host restoring a document that was read before says what was in force
   * rather than clicking rows, and the pages are re-cropped the same way
   * checking them by hand would. An expression the menu has no named rule for -
   * one a host set directly, or another document's title - is given a row of
   * its own rather than dropped: it is what the pages are being cut to, and a
   * reader is entitled to see it and remove it.
   */
  setPatterns(patterns: readonly string[], padding: number): void;
  /** Page units kept around the content, as the field has it. */
  readonly padding: number;
  destroy(): void;
}

export function createCropMenu(opts: CropMenuOptions): CropMenu {
  const { button, menu, list, status, allButton, noneButton, padding: padInput, add } = opts;
  const selected = new Set<CropRuleId>();
  /** The reader's own rules, in the order they were added. */
  const custom: CropRule[] = [...(opts.customRules ?? [])];
  /**
   * Rows for expressions that were restored and that no named rule explains:
   * a pattern a host set directly, or another document's title. They last for
   * this document's sitting and are not among the reader's own rules.
   */
  let adopted: CropRule[] = [];
  const rows = new Map<CropRuleId, HTMLButtonElement>();
  let cursor = 0;
  let padding = DEFAULT_PADDING;
  let title = '';
  let progress: CropProgress = { measured: 0, total: 0, running: false };
  let destroyed = false;

  /** Every rule the menu draws: the built-in ones, the reader's, and any adopted. */
  function allRules(): CropRule[] {
    return [...CROP_RULES, ...custom, ...adopted];
  }

  /** The option buttons, in the order the rules are listed. */
  const elements = (): HTMLButtonElement[] =>
    allRules()
      .map((rule) => rows.get(rule.id))
      .filter((el): el is HTMLButtonElement => !!el);

  function usable(rule: CropRule): boolean {
    return ruleUsable(rule, title);
  }

  /** What the row prints under its name: the expression, with the title in it. */
  function patternOf(rule: CropRule): string {
    return expandPattern(rule, title);
  }

  /** What hovering a row says: the expression, and why it may be inert here. */
  function tipFor(rule: CropRule): string {
    let tip = patternOf(rule);
    if (rule.id === RECOMMENDED_RULE_ID) tip += '\nThe rule most documents want';
    if (!usable(rule)) tip += '\nthis document declares no title';
    return tip;
  }

  function buildRow(rule: CropRule): HTMLElement {
    const row = document.createElement('div');
    row.className = 'crop-row';

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'crop-option';
    el.setAttribute('role', 'option');
    el.dataset.id = rule.id;
    el.title = tipFor(rule);

    const check = document.createElement('span');
    check.className = 'crop-check';
    check.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'crop-text';
    const name = document.createElement('span');
    name.className = 'crop-name';
    name.textContent = rule.label;
    if (rule.id === RECOMMENDED_RULE_ID) {
      const star = document.createElement('span');
      star.className = 'star';
      star.setAttribute('aria-hidden', 'true');
      star.textContent = '★';
      name.appendChild(star);
    }
    // The expression itself, and nothing about it: what a rule does is what it
    // says, and the reader can read it off the row.
    const pattern = document.createElement('span');
    pattern.className = 'crop-pattern mono';
    pattern.textContent = patternOf(rule);
    text.append(name, pattern);

    el.append(check, text);
    el.addEventListener('click', () => {
      cursor = Math.max(0, elements().indexOf(el));
      toggleRule(rule.id);
    });
    el.addEventListener('keydown', onListKeyDown);
    rows.set(rule.id, el);
    row.append(el);

    if (rule.custom) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'crop-remove';
      remove.textContent = '×';
      remove.title = `Remove “${rule.label}”`;
      remove.setAttribute('aria-label', `Remove the rule ${rule.label}`);
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removeRule(rule.id);
      });
      row.append(remove);
    }
    return row;
  }

  /**
   * Draw the list again from the rules there are now.
   *
   * A reader can add and remove rules while the panel is open, and a row carries
   * its rule's name and expression in its own markup - so the list is rebuilt
   * rather than patched. The selection is by id and survives it.
   */
  function rebuild(): void {
    rows.clear();
    list.replaceChildren(...allRules().map(buildRow));
  }

  rebuild();

  /* --------------------------------------------------------------- state */

  function toggleRule(id: CropRuleId): void {
    const rule = allRules().find((each) => each.id === id);
    // A rule that cannot apply is not a rule this document can check: toggling
    // it would report a mark left out that was never going to be there.
    if (!rule || !usable(rule)) return;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
    emit();
  }

  function emit(): void {
    opts.onChange(patterns(), padding);
  }

  /** What the field says, as a number: clamped, and never a NaN. */
  function readPadding(): number {
    const value = Number.parseFloat(padInput.value);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_PADDING, value);
  }

  function applyPadding(): void {
    const next = readPadding();
    // The field keeps what was typed until it means something: `0.` and `` are
    // on the way to a number, and rewriting them mid-keystroke is a fight.
    if (next === padding) return;
    padding = next;
    render();
    emit();
  }

  /** The checked expressions, in list order, exactly as the core will read them. */
  function patterns(): string[] {
    return allRules()
      .filter((rule) => usable(rule) && selected.has(rule.id))
      .map((rule) => patternOf(rule));
  }

  /** Every rule that applies to this document is already checked. */
  function allSelected(): boolean {
    return allRules().every((rule) => !usable(rule) || selected.has(rule.id));
  }

  function setAll(on: boolean): void {
    selected.clear();
    // Only rules that can apply: checking one that this document cannot use
    // would report a mark as left out that was never going to be there.
    if (on) for (const rule of allRules()) if (usable(rule)) selected.add(rule.id);
    render();
    emit();
    // The panel stays open: the point of the button is to see the list change.
    const first = elements()[0];
    if (first) scrollIntoPanel(first, list);
  }

  function showError(message: string | null): void {
    add.error.textContent = message ?? '';
    add.error.hidden = !message;
  }

  /**
   * Add a rule the reader typed, if the core will have it.
   *
   * The check is the core's and not this page's: the engine that applies a
   * pattern is the only one that can say what a pattern is, and a JavaScript
   * `RegExp` would answer about a different language. A refusal is shown beside
   * the fields and nothing is added.
   */
  async function addRule(label: string, pattern: string): Promise<void> {
    const expression = pattern.trim();
    if (expression === '') {
      showError('Type an expression first.');
      add.pattern.focus();
      return;
    }
    if (allRules().some((rule) => rule.pattern === expression)) {
      showError('That expression is already a rule.');
      return;
    }
    let refused: string | null = null;
    try {
      refused = await opts.checkPattern(expression);
    } catch (error) {
      refused = `the core could not check it: ${String(error)}`;
    }
    if (destroyed) return;
    if (refused) {
      showError(`Not a regular expression: ${refused}`);
      add.pattern.focus();
      return;
    }
    const name = label.trim() || expression;
    const rule: CropRule = {
      id: nextCustomId(allRules().map((each) => each.id)),
      label: name,
      pattern: expression,
      custom: true,
    };
    custom.push(rule);
    opts.onCustomRules?.(custom);
    rebuild();
    selected.add(rule.id);
    add.name.value = '';
    add.pattern.value = '';
    showError(null);
    render();
    emit();
    const el = rows.get(rule.id);
    if (el) scrollIntoPanel(el, list);
  }

  function removeRule(id: CropRuleId): void {
    const own = custom.findIndex((rule) => rule.id === id);
    if (own >= 0) {
      custom.splice(own, 1);
      opts.onCustomRules?.(custom);
    } else {
      // An adopted expression is not one of the reader's own rules: it is this
      // document's crop, and removing the row is how it is unchecked.
      const at = adopted.findIndex((rule) => rule.id === id);
      if (at < 0) return;
      adopted.splice(at, 1);
    }
    selected.delete(id);
    cursor = Math.min(cursor, Math.max(0, allRules().length - 1));
    rebuild();
    render();
    emit();
  }

  /* --------------------------------------------------------------- render */

  /**
   * Select the rules that produce these expressions, and give a row to the ones
   * no rule explains.
   *
   * The expressions are what a crop *is*, so they are the currency of the memory
   * as well as of the engine: an expression the menu can name is checked, and
   * one it cannot is adopted.
   */
  function setPatterns(list: readonly string[], next: number): void {
    const stored = normalisePatterns(list);
    adopted = [];
    selected.clear();
    const named = new Set<string>();
    for (const rule of [...CROP_RULES, ...custom]) {
      const pattern = patternOf(rule);
      if (stored.includes(pattern)) {
        selected.add(rule.id);
        named.add(pattern);
      }
    }
    for (const pattern of stored) {
      if (named.has(pattern)) continue;
      adopted.push({
        id: nextCustomId(allRules().map((rule) => rule.id)),
        label: pattern,
        pattern,
        custom: true,
      });
    }
    for (const rule of adopted) selected.add(rule.id);
    if (Number.isFinite(next)) padding = Math.min(MAX_PADDING, Math.max(0, next));
    padInput.value = String(padding);
    rebuild();
    render();
    emit();
  }

  function render(): void {
    cursor = Math.min(cursor, Math.max(0, elements().length - 1));
    for (const rule of allRules()) {
      const el = rows.get(rule.id);
      if (!el) continue;
      const on = selected.has(rule.id);
      const ok = usable(rule);
      el.setAttribute('aria-selected', String(on));
      el.setAttribute('aria-disabled', String(!ok));
      el.classList.toggle('disabled', !ok);
      el.classList.toggle('active', elements()[cursor] === el);
      const pattern = el.querySelector('.crop-pattern');
      if (pattern) pattern.textContent = patternOf(rule);
      el.title = tipFor(rule);
    }
    const chosen = patterns();
    // One bulk button at a time, and it always says what is left to do rather
    // than what was just done: "Enable all" is PaperCutter's own behaviour and
    // is offered until every rule that applies to this document is checked,
    // and from there the only move left is back.
    const every = allSelected();
    allButton.hidden = every;
    noneButton.hidden = !every;
    padInput.disabled = chosen.length === 0;
    // The same "on" the bionic control carries: an accent background while the
    // pages are being changed, and nothing but a border while they are not.
    button.dataset.on = String(chosen.length > 0);
    button.setAttribute(
      'title',
      chosen.length
        ? `Cropping pages to their content, leaving out what ${chosen.length} expression${chosen.length === 1 ? '' : 's'} match`
        : 'Trim each page to its content, leaving out the runs your expressions match',
    );
    status.textContent = describe(chosen.length);
  }

  function describe(count: number): string {
    if (count === 0) return 'Nothing checked — pages are shown whole.';
    const plus = padding > 0 ? `, +${padding} pt` : '';
    if (progress.running) return `Cropping… ${progress.measured}/${progress.total} pages`;
    return `Cropped to content${plus}, minus ${count} expression${count === 1 ? '' : 's'}.`;
  }

  function move(delta: number): void {
    const list_ = elements();
    if (list_.length === 0) return;
    cursor = Math.min(list_.length - 1, Math.max(0, cursor + delta));
    render();
    scrollIntoPanel(list_[cursor], list);
  }

  /* ------------------------------------------------------------- keyboard */

  function onButtonKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) open();
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      close();
    }
  }

  function onListKeyDown(event: KeyboardEvent): void {
    const el = event.currentTarget as HTMLButtonElement;
    const id = el.dataset.id;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      button.focus();
    } else if (event.key === ' ' || event.key === 'Enter') {
      if (!id) return;
      event.preventDefault();
      toggleRule(id);
    } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setAll(true);
    }
  }

  button.addEventListener('keydown', onButtonKeyDown);
  allButton.addEventListener('click', () => setAll(true));
  noneButton.addEventListener('click', () => setAll(false));
  // Debounced like the find box: a page's whole layout is rebuilt when this
  // changes, and every keystroke in `12` is not two layouts.
  let padTimer = 0;
  padInput.addEventListener('input', () => {
    clearTimeout(padTimer);
    padTimer = window.setTimeout(applyPadding, 160);
  });
  padInput.addEventListener('change', () => {
    clearTimeout(padTimer);
    applyPadding();
    // A value that meant nothing (`0.`, `-3`) is replaced by what it resolved to.
    padInput.value = String(padding);
  });
  padInput.addEventListener('blur', () => {
    clearTimeout(padTimer);
    applyPadding();
    padInput.value = String(padding);
  });
  padInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(padTimer);
      applyPadding();
      padInput.value = String(padding);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      button.focus();
    }
  });

  const onAddSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    void addRule(add.name.value, add.pattern.value);
  };
  add.form.addEventListener('submit', onAddSubmit);
  add.pattern.addEventListener('input', () => showError(null));

  /* ----------------------------------------------------------------- open */

  function open(): void {
    if (destroyed) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    cursor = Math.max(0, allRules().findIndex((rule) => selected.has(rule.id)));
    render();
    const first = elements()[cursor];
    if (first) scrollIntoPanel(first, list);
  }

  function close(): void {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  return {
    open,
    close,
    toggle(): void {
      if (menu.hidden) open();
      else close();
    },
    get isOpen(): boolean {
      return !menu.hidden;
    },
    setDocument(next: string): void {
      title = next;
      render();
    },
    get padding(): number {
      return padding;
    },
    setProgress(state: CropProgress): void {
      progress = state;
      status.textContent = describe(patterns().length);
    },
    patterns,
    setAll,
    setPatterns,
    destroy(): void {
      destroyed = true;
      button.removeEventListener('keydown', onButtonKeyDown);
      add.form.removeEventListener('submit', onAddSubmit);
    },
  };
}
