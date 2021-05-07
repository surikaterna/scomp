import { EventEmitter2 } from 'eventemitter2';
import { RequestPacket, ResponsePacket, ScompHeader } from '../scomp';
import { WireEvent } from '../WireInterface';
import { SocketService } from './SocketService';
import { getActualIds } from './Utils';

export interface ServerSocketWireConfig {
  server?: any;
  io?: any;
  bidirectional: boolean;
}

type Socket = any;

export default class ServerSocketWire extends EventEmitter2 {
  private io: any;
  private server: any;
  private nsp: any;
  private socketService: SocketService;
  private _sockets: Record<string, Socket>;

  constructor(settings: ServerSocketWireConfig) {
    super();
    
    // Settings
    this.server = settings.server;

    if (settings.io) {
      this.io = settings.io;
    } else {
      const io = require('socket.io')();
      this.io = io;
    }

    // namespace
    this.nsp = this.io.of('/scomp');

    this.socketService = new SocketService(this.io);
    this._sockets = {};

    this.nsp.on('connection', (socket: Socket) => {
      // TODO: Do authentication before register socket.
      console.log(socket.id);
      this.socketService.register(socket);
    });

    this.socketService.on('connected', socket => {
      this._sockets[socket.id] = socket;

      socket.on('disconnect', () => {
        console.log('disconnect!!!!!');
        delete this._sockets[socket.id];
      });

      // Request handler
      socket.on(WireEvent.Request, (packet: RequestPacket) => {
        const data = packet;
        data.id = `${socket.id}$$${packet.id}`;
        this._handleRequestPacket(data);
      });

      // Response handler
      if (settings.bidirectional) {
        socket.on(WireEvent.Response, (packet: ResponsePacket) =>  this._handleResponsePacket(packet));
      }
    });
  }

  _handleRequestPacket(packet: RequestPacket) {
    // emit 'req' event which ScompServer will handle
    this.emit(WireEvent.Request, packet);
  }

  _handleResponsePacket(packet: ResponsePacket) {
    // emit 'res' event' which Scomp will handle
    console.log('_handleResponsePacket', packet);
    this.emit(WireEvent.Response, packet);
  }

  listen() {
    this.socketService.io.listen(this.server);
  }

  send(event: WireEvent, packet: ResponsePacket | RequestPacket, headers: ScompHeader) {
    if (event === WireEvent.Request) {
      const socketId = headers ? headers.socketId : null;
      if (socketId) {
        this.io.to(socketId).emit(WireEvent.Request, packet);
      } else {
        this.io.of('/scomp').emit(WireEvent.Request, packet);
        // this.io.emit(SOCKET_EVENTS.Request, packet);
      }
    } else {
      const data = packet;
      const { socketId, packetId } = getActualIds(packet);
      if (socketId && this._sockets[socketId] && this._sockets[socketId].connected) {
        data.id = packetId;
        this._sockets[socketId].emit(event, data);
      } else {
        throw Error(`Socket has been disconnected ${socketId} for packet ${packetId}.`);
      }
    }
  }
}
