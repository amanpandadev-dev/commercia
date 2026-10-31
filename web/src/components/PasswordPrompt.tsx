import { useEffect, useRef, useState } from 'react';
import { onPasswordNeeded } from '../api';
import { Field, Modal } from './ui';

/** "Type your password to continue": shown when a risky action asks for it again. Mounted once, inside the signed-in app. */
export function PasswordPrompt() {
  const [ask, setAsk] = useState<{ problem?: string } | null>(null);
  const [password, setPassword] = useState('');
  const settle = useRef<((p: string | null) => void) | null>(null);
  useEffect(
    () =>
      onPasswordNeeded(
        (problem) =>
          new Promise((resolve) => {
            settle.current = resolve;
            setPassword('');
            setAsk({ problem });
          }),
      ),
    [],
  );
  if (!ask) return null;
  const done = (value: string | null) => {
    settle.current?.(value);
    settle.current = null;
    setAsk(null);
  };
  return (
    <div style={{ position: 'relative', zIndex: 100 }}>
    <Modal
      title="Type your password to continue"
      sub="This action needs your password again. It stays confirmed for a few minutes."
      onClose={() => done(null)}
      foot={
        <>
          {ask.problem && <span className="err grow">{ask.problem}</span>}
          <button className="btn" onClick={() => done(null)}>Cancel</button>
          <button className="btn primary" disabled={!password} onClick={() => done(password)}>Continue</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); if (password) done(password); }}>
        <Field label="Your password">
          <input className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </form>
    </Modal>
    </div>
  );
}
