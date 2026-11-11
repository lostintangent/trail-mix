import { useState } from 'react';

/** A value that holds still while `isHeld`, and follows its input otherwise. */
export function useHeldWhile<T>(isHeld: boolean, value: T): T {
  const [shown, setShown] = useState(value);
  if (!isHeld && shown !== value) setShown(value);
  return isHeld ? shown : value;
}
