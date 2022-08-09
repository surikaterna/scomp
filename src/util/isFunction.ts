/**
 * Returns true if the object is a function.
 * @param value The value to check
 */
export default function isFunction(value: any): value is (...args: any[]) => any {
  return typeof value === 'function';
}
