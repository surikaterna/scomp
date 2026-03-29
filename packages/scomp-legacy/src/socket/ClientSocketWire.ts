import { EventEmitter2 } from 'eventemitter2';
import io from 'socket.io-client';
import { RequestPacket, ResponsePacket } from '../scomp';
import WireInterface, { WireEvent } from '../WireInterface';
import { getActualIds } from './Utils';

/**
 * Configuration for creating a client-side socket wire.
 */
export interface ClientSocketWireConfig {
  socket?: any;
  address: string;
  bidirectional: boolean;
  authentication?: {
    token: string;
    extra?: any;
  }
}

/**
 * Socket.IO based client transport for legacy scomp runtime.
 */
export default class ClientSocketWire extends EventEmitter2 implements WireInterface {
  private socket: any;

  /**
   * Creates a client wire and binds socket event listeners.
   */
  constructor(config: ClientSocketWireConfig) {
    super();

    if (config.socket) {
      this.socket = config.socket;
    } else {
      console.log(config.address + '/scomp');
      this.socket = io(config.address + '/scomp', { transports: ['websocket', 'polling'] });
    }

    this.socket.on('connect', () => {
      this.emit('connected');
      console.log(this.socket.id);
    });

    this.socket.on('disconnect', () => {
      this.emit('disconnect');
    });

    this.socket.on('res', this._handleResponsePacket.bind(this));

    if (config.authentication) {
      this.socket.emit('authenticate', { ...config.authentication });
    }

    this.socket.on('authenticated', () => this.emit(WireEvent.Authenticated));

    if (config.bidirectional) {
      this.socket.on('req', (packet: RequestPacket) => {
        const data = packet;
        data.id = `${this.socket.id}$$${packet.id}`;

        console.log('xxxxxxxxxxxxxxxxxxxxxx', data.id);
        this._handleRequestPacket(data);
      });
    }
  }

  /** Handles inbound request packets in bidirectional mode. */
  _handleRequestPacket(packet: RequestPacket) {
    console.log('Receiving request packet', packet);
    this.emit('req', packet);
  }

  /** Handles inbound response packets. */
  _handleResponsePacket(packet: ResponsePacket) {
    this.emit('res', packet);
  }

  /** @inheritdoc */
  send(event: WireEvent, packet: RequestPacket | ResponsePacket) {
    const data = packet;
    if (event === WireEvent.Response) {
      const { packetId } = getActualIds(packet);
      data.id = packetId;
    }
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, data);
    } else {
      throw new Error('Socket has been disconnected.');
    }
  }

  /** @inheritdoc */
  getConnections() {
    return [];
  }
}
