import { useState } from "react";
import {
  clearRecentAccounts,
  getRecentAccounts,
  isRememberEnabled,
  setRememberEnabled,
} from "../lib/recentAccounts";
import Button from "./Button";

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
      <Button
        type="button"
        disabled={count === 0}
        onClick={() => {
          clearRecentAccounts();
          setCount(0);
        }}
        variant="secondary"
        style={{ alignSelf: "flex-start", marginTop: "0.5rem" }}
      >
        {count === 0 ? "Nothing remembered" : `Forget all (${count})`}
      </Button>
    </>
  );
}
