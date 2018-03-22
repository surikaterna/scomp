# SCOMP

RPC experiment

## Concepts

- Unary

service()

## Usage

```javascript
  const scomp = new Scomp(new SocketIOWire(io));
  const client = scomp.client();

  // void result function
  scomp.call(client.saft.get('console').log('Hey ho!'));

  // void result function ($ always initiates a call, or rename to then to be more promise like)
  client.saft.get('console').log('Hey ho!').$();

  // return from promise
  client.viewdb.collection('order').findByPromise({}).$()
    .then(console.log);
  // shortcut to just use .then() <-- trigger call
  client.viewdb.collection('order').findByPromise({})
    .then(console.log);

// return stream
  client.viewdb.collection('order').find({}).toArray(scomp.callback()).$()
    .on('data', data=>{}) // data element
    .on('end', ()=>{}) // other side terminated stream
    ;  
  ```

## Wire format

### Request Client -> Server

```json
{
  id: 123123121,
  req: {
    s:'saft'
    p:['eh', 'oh']
  }
}
```

### Response Server -> Client

```json
{
  id: 123123121, // corresponds to
  res: {}, // user data
  str: {}, // stream control data
  err: {} // error
}
```

### Stream Control (Most commony Server -> Client)

```json
{
  id: 123123123, // corresponds to
  seq: 0, // sequence of events, start at 0
  res: {}, // user data
  str: {}, // stream control data
  err: {} // error
}
```