import { Scomp } from './scomp';
import { ScompServer } from './server/ScompServer';
import ClientSocketWire from './socket/ClientSocketWire';
import ServerSocketWire from './socket/ServerSocketWire';
import NullWire from './null';
import WireInterface from './WireInterface';
import Observable from './Observable';
import ControlledObservable from './ControlledObservable';

/**
 * Legacy scomp package entrypoint.
 *
 * @remarks
 * These exports preserve the original API surface for backward compatibility.
 */
export { 
  Scomp,
  ScompServer,
  ClientSocketWire,
  ServerSocketWire,
  NullWire,
  WireInterface,
  Observable,
  ControlledObservable
}
