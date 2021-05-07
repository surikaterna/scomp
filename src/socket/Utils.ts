import { RequestPacket, ResponsePacket } from '../scomp';

const DELIMETER = '$$';

const getActualIds = (packet: ResponsePacket | RequestPacket) => {
  let packetId = packet.id;
  let socketId;
  if (packet.id && packet.id.indexOf(DELIMETER)) {
    const splittedKeys = packet.id.split(DELIMETER);
    socketId = splittedKeys[0];
    packetId = splittedKeys[1];
  }
  return { socketId, packetId };
};

export {
  getActualIds
}