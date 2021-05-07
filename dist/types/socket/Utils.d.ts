import { RequestPacket, ResponsePacket } from '../scomp';
declare const getActualIds: (packet: ResponsePacket | RequestPacket) => {
    socketId: string | undefined;
    packetId: string;
};
export { getActualIds };
