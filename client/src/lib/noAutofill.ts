// Spread onto any free-text <input> or <textarea> that is not part of signing in:
//
//   <input {...noAutofill} value={name} onChange={...} />
//
// Password managers decide what a box is from its placeholder, name, id and label, so a plain "name"
// or "username" box can make them offer logins or identities where none belong. `autocomplete="off"`
// is ignored by most of them for credentials, so each manager that documents an opt-out gets its own:
//
//   data-1p-ignore          1Password
//   data-lpignore="true"    LastPass (needs the explicit "true")
//   data-bwignore           Bitwarden
//   data-form-type="other"  Dashlane (its "semantically annotated web forms" hint)
//   data-protonpass-ignore  Proton Pass
//
// There is no shared standard, and no documented attribute for NordPass or Keeper (as far as we could
// find), nor for the browsers' and OS keychains' built-in managers beyond `autocomplete="off"`. For
// those, the only lever is not looking like a credential field: don't call an input "username",
// "email" or "login" in its name/id, and keep the visible label specific. Check the list against each
// vendor's current docs from time to time; it is a snapshot.
//
// Sign-in, register and the two-factor code deliberately do NOT use this (they should be filled), and
// the password prompts in Settings name their real autocomplete value instead. noAutofill.test.ts
// fails if a free-text input is added without either.
export const passwordManagerIgnore = {
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
  "data-form-type": "other",
  "data-protonpass-ignore": true,
} as const;

export const noAutofill = {
  autoComplete: "off",
  ...passwordManagerIgnore,
} as const;
