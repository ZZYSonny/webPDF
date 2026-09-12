/**
 * The crop dropdown.
 *
 * Cropping a page to its content is the one thing in this reader that changes
 * what a document looks like, so it is opt-in twice over: it does nothing at
 * all until a rule is checked, and every rule can be switched on and off
 * individually. The rules are PaperCutter's (`core/src/crop.rs` names each one
 * after the line it came from, and `./core/rules.ts` here is the same list for
 * the panel to draw); what they remove is the *marks* - a publisher's
 * footer, an arXiv stamp, a bare page number - so that a box built from what
 * remains is the content and not the margins those marks needed.
 *
 * The panel is a listbox of toggles rather than a set of checkboxes because it
 * lives in the same bar as the zoom menu and behaves like it: one dropdown open
 * at a time, arrow keys to move, Escape to leave. "Enable all" is the reference
 * script's own behaviour; "Disable all" is how a reader gets their page back.
 */

// The list the panel draws is the page's copy of the core's own: the ids and the
// wording travel together, and the core answers for what each one measures.
import { CROP_RULES } from './core/rules.ts';
import type { CropRule, CropRuleId } from './core/types.ts';
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
  /** The rules, or the padding, changed: apply both. */
  onChange: (rules: CropRuleId[], padding: number) => void;
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

/**
 * The rule the panel stars: the one nearly every paper needs, and the one
 * PaperCutter's own defaults are about. The star is a recommendation, not a
 * state - the row starts unchecked like every other, because cropping is
 * opt-in (see the file header).
 */
const RECOMMENDED: CropRuleId = 'page-number';

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
  /** The selection, in rule order. */
  rules(): CropRuleId[];
  /** Check every rule, or none of them. */
  setAll(on: boolean): void;
  /**
   * Put the panel back where a reader left it: exactly these rules, at this
   * padding. A host restoring a document that was read before says what was in
   * force rather than clicking rows, and the pages are re-cropped the same way
   * checking them by hand would.
   */
  setRules(rules: readonly CropRuleId[], padding: number): void;
  /** Page units kept around the content, as the field has it. */
  readonly padding: number;
  destroy(): void;
}

export function createCropMenu(opts: CropMenuOptions): CropMenu {
  const { button, menu, list, status, allButton, noneButton, padding: padInput } = opts;
  const selected = new Set<CropRuleId>();
  const rows = new Map<CropRuleId, HTMLButtonElement>();
  let cursor = 0;
  let padding = DEFAULT_PADDING;
  let title = '';
  let progress: CropProgress = { measured: 0, total: 0, running: false };
  let destroyed = false;

  /** The rows, in the order the rules are declared. */
  const elements = (): HTMLButtonElement[] => CROP_RULES.map((rule) => rows.get(rule.id)).filter((el): el is HTMLButtonElement => !!el);

  function usable(rule: CropRule): boolean {
    return !rule.needsTitle || title !== '';
  }

  function buildRow(rule: CropRule): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'crop-option';
    el.setAttribute('role', 'option');
    el.dataset.id = rule.id;
    // The literal test, so what a rule does is never a guess.
    el.title = `${rule.hint}\n${rule.source}`;

    const check = document.createElement('span');
    check.className = 'crop-check';
    check.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'crop-text';
    const name = document.createElement('span');
    name.className = 'crop-name';
    name.textContent = rule.label;
    if (rule.id === RECOMMENDED) {
      const star = document.createElement('span');
      star.className = 'star';
      star.setAttribute('aria-hidden', 'true');
      star.textContent = '★';
      name.appendChild(star);
      el.title += '\nThe rule most documents want';
    }
    const hint = document.createElement('span');
    hint.className = 'crop-hint';
    hint.textContent = rule.hint;
    text.append(name, hint);

    el.append(check, text);
    el.addEventListener('click', () => {
      cursor = Math.max(0, elements().indexOf(el));
      toggleRule(rule.id);
    });
    el.addEventListener('keydown', onListKeyDown);
    rows.set(rule.id, el);
    return el;
  }

  list.replaceChildren(...CROP_RULES.map(buildRow));

  /* --------------------------------------------------------------- state */

  function toggleRule(id: CropRuleId): void {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
    emit();
  }

  function emit(): void {
    opts.onChange(selection(), padding);
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

  function selection(): CropRuleId[] {
    return CROP_RULES.filter((rule) => selected.has(rule.id)).map((rule) => rule.id);
  }

  /** Every rule that applies to this document is already checked. */
  function allSelected(): boolean {
    return CROP_RULES.every((rule) => !usable(rule) || selected.has(rule.id));
  }

  function setAll(on: boolean): void {
    selected.clear();
    // Only rules that can apply: checking one that this document cannot use
    // would report a mark as left out that was never going to be there.
    if (on) for (const rule of CROP_RULES) if (usable(rule)) selected.add(rule.id);
    render();
    emit();
    // The panel stays open: the point of the button is to see the list change.
    const first = elements()[0];
    if (first) scrollIntoPanel(first, list);
  }

  /* --------------------------------------------------------------- render */

  function setRules(rules: readonly CropRuleId[], next: number): void {
    selected.clear();
    for (const rule of CROP_RULES) if (rules.includes(rule.id)) selected.add(rule.id);
    if (Number.isFinite(next)) padding = Math.min(MAX_PADDING, Math.max(0, next));
    padInput.value = String(padding);
    render();
    emit();
  }

  function render(): void {
    const list_ = elements();
    cursor = Math.min(cursor, Math.max(0, list_.length - 1));
    for (const rule of CROP_RULES) {
      const el = rows.get(rule.id);
      if (!el) continue;
      const on = selected.has(rule.id);
      const ok = usable(rule);
      el.setAttribute('aria-selected', String(on));
      el.setAttribute('aria-disabled', String(!ok));
      el.classList.toggle('disabled', !ok);
      el.classList.toggle('active', elements()[cursor] === el);
      const hint = el.querySelector('.crop-hint');
      if (hint && rule.needsTitle) hint.textContent = ok ? rule.hint : 'this document declares no title';
    }
    const chosen = selection();
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
        ? `Cropping pages to their content, leaving out ${chosen.length} kind${chosen.length === 1 ? '' : 's'} of mark`
        : 'Trim each page to its content, leaving out the marks you check',
    );
    status.textContent = describe();
  }

  function describe(): string {
    if (selected.size === 0) return 'Nothing checked — pages are shown whole.';
    const plus = padding > 0 ? `, +${padding} pt` : '';
    if (progress.running) return `Cropping… ${progress.measured}/${progress.total} pages`;
    return `Cropped to content${plus}, minus ${selected.size} kind${selected.size === 1 ? '' : 's'} of mark.`;
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
    const rule = CROP_RULES.find((r) => r.id === el.dataset.id);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
      button.focus();
    } else if ((event.key === ' ' || event.key === 'Enter') && rule) {
      event.preventDefault();
      toggleRule(rule.id);
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

  /* ----------------------------------------------------------------- open */

  function open(): void {
    if (destroyed) return;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    cursor = Math.max(0, CROP_RULES.findIndex((rule) => selected.has(rule.id)));
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
      status.textContent = describe();
    },
    rules: selection,
    setAll,
    setRules,
    destroy(): void {
      destroyed = true;
      button.removeEventListener('keydown', onButtonKeyDown);
    },
  };
}
