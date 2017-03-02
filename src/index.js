export class Scomp {
  constructor(wire) {
    this._wire = wire || new NullWire();
  }

  request(req) {
    this._wire(req);
  }
}
