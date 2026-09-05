/**
 * Minimal, best-effort types for the small subset of Adobe Acrobat's own
 * JavaScript API commonly needed to write a form field's `onClick` action
 * (see docs/forms.md). This is not a full Acrobat SDK type surface -- only
 * the handful of globals most `onClick` handlers reach for. Contributions
 * extending it are welcome.
 *
 * These aren't ambient/global declarations: `app`, `getField`, `display` and
 * `event` only exist inside a PDF viewer's own JavaScript engine at the
 * moment the action runs, never in the Node or browser code that builds the
 * PDF, so declaring them as globals would risk colliding with unrelated
 * identifiers elsewhere in a project (a bare global `event`, for example,
 * collides with the DOM lib's own deprecated `window.event`).
 *
 * Instead, write `onClick` as a function that takes them as parameters --
 * pdfkit calls the generated action with the real Acrobat globals in that
 * position (and `this` bound to the Document, exactly as Acrobat itself
 * binds it in any field action), so this works exactly like referencing
 * them as globals would, without ever declaring one:
 *
 *   import type { AcrobatOnClick } from 'pdfkit/types/acrobat-js';
 *
 *   const onClick: AcrobatOnClick = function (app, getField, display) {
 *     app.alert('clicked');
 *     this.getField('otherField').value = 'updated from btn1';
 *   };
 *
 * Declare only the leading parameters your handler actually uses --
 * `function (app) {}` or even `function () {}` are both valid AcrobatOnClick
 * values. The call always passes all of them (`this`, `app`, `getField`,
 * `display`, `event`, in that order); a handler that declares fewer simply
 * never sees the rest, the same way `array.map(item => ...)` can ignore the
 * `index` and `array` parameters its callback type also offers.
 *
 * (`this` isn't available in an arrow function, and Acrobat's own JS engine
 * may not support arrow function syntax at all -- write `onClick` as a
 * plain `function` for the widest viewer support.)
 */

/**
 * Partial: Acrobat's real `app` object has many more methods (`execDialog`,
 * `launchURL`, `response`, `thermometer`, ...). Only the ones common enough
 * to include here are listed.
 */
export interface AcrobatApp {
  alert(
    message: string,
    icon?: number,
    type?: number,
    title?: string,
  ): number;
  execMenuItem(name: string): void;
}

/** Partial: a real field object has many more properties than these. */
export interface AcrobatField {
  value: string | number;
  display: number;
  readonly: boolean;
  hidden: boolean;
}

/** Complete: this is Acrobat's full, fixed set of `display` constants. */
export interface AcrobatDisplay {
  visible: 0;
  hidden: 1;
  noPrint: 2;
  noView: 3;
}

export type AcrobatGetField = (name: string) => AcrobatField;

/** Partial: a real field-action event object has more properties than these. */
export interface AcrobatEvent {
  target: AcrobatField;
  value: string | number;
  rc: boolean;
  willCommit: boolean;
}

/**
 * Partial: the Document object Acrobat binds `this` to in any field action.
 * A real Document has hundreds of members; only these two are declared here.
 */
export interface AcrobatDocument {
  getField: AcrobatGetField;
  numPages: number;
}

export type AcrobatOnClick = (
  this: AcrobatDocument,
  app: AcrobatApp,
  getField: AcrobatGetField,
  display: AcrobatDisplay,
  event: AcrobatEvent,
) => void;
