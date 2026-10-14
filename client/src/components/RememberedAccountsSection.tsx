import { useState } from "react";
import {
  clearRecentAccounts,
  getRecentAccounts,
  isRememberEnabled,
  setRememberEnabled,
} from "../lib/recentAccounts";

/** Settings: control the list of servers and usernames this device offers on the sign-in page. */
export default function RememberedAccountsSection() {
  const [count, setCount] = useState(() => getRecentAccounts().length);
  const [remember, setRemember] = useState(() => isRememberEnabled());

  return (
    <>
      <h3>Remembered accounts</h3>
      <p className="hint">
        This device offers the servers and usernames you have signed in with on the sign-in page. Passwords and login
        tokens are never part of that list.
      </p>
      <label className="remember-option">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => {
            setRemember(e.target.checked);
            setRememberEnabled(e.target.checked);
          }}
        />
        Remember servers and usernames on this device
      </label>
      <button
        type="button"
        className="btn-secondary"
        style={{ borderRadius: 6, alignSelf: "flex-start", marginTop: 8 }}
        disabled={count === 0}
        onClick={() => {
          clearRecentAccounts();
          setCount(0);
        }}
      >
        {count === 0 ? "Nothing remembered" : `Forget all (${count})`}
      </button>
    </>
  );
}
