const fastify = require('fastify');
const sse = require('sly-fastify-sse');
const { PassThrough } = require("stream");

const app = fastify();

app.register(sse);

const read = new PassThrough({objectMode: true});

const id = setInterval(() => {
  read.write({ timestamp: new Date(), ok: 'test' }); 
}, 10000);

app.get("/sse2", (request, reply) => {
  // const stream = new PassThrough({objectMode: true});
  // read.pipe(stream);
  reply.sse(read, {
    idGenerator: (event) => {
      // Retrieve the event name using the key myIdentifiant or use the timestamp if not exists …
      return event.timestamp;
    },
    event: false,
  });

});

app.listen(9000);