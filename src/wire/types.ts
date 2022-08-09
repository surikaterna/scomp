interface WirePacket {
  /** stream or call id */
  id: string;

}

interface WireRequestCommand {}

interface WireRequest extends WirePacket {
  req: {
    commands: WireRequestCommand[];
  };
}

type WireError = any;

interface WireResponse extends WirePacket {
  res?: {

  }, 
  error?: WireError;
}

interface WireStreamEvent extends WireResponse {
    str: {}
}
