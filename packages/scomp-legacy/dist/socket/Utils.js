"use strict";
exports.__esModule = true;
exports.getActualIds = void 0;
var DELIMETER = '$$';
var getActualIds = function (packet) {
    var packetId = packet.id;
    var socketId;
    if (packet.id && packet.id.indexOf(DELIMETER)) {
        var splittedKeys = packet.id.split(DELIMETER);
        socketId = splittedKeys[0];
        packetId = splittedKeys[1];
    }
    return { socketId: socketId, packetId: packetId };
};
exports.getActualIds = getActualIds;
//# sourceMappingURL=Utils.js.map