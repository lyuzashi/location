const mongo = require('mongodb');
const fastify = require('fastify');
const sse = require('sly-fastify-sse');
const { PassThrough } = require("stream");
const fs = require('fs');

const port = process.env.PORT || '/run/location.sock';
const app = fastify();
const client = mongo.MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017');

app.register(sse);

const getLastLocation = async () => (await client).db('memory').collection('locations').find({})
  .sort({'properties.timestamp': -1}).limit(1).next();

const transform = geo => ({
  ...geo,
  properties: {
    ...geo.properties,
    timestamp: new Date(geo.properties.timestamp),
  },
});

const stream = new PassThrough({objectMode: true});

app.post('/location', async (request, reply) => {
  reply.send({
    result: 'ok'
  });
  const db = (await client).db('memory');
  const locations = request.body.locations.map(transform);
  await db.collection('locations').insertMany(locations);
  request.body.trip && await db.collection('trips').insertOne(transform(request.body.trip));
  locations.forEach(location => {
    stream.write({ id: location.properties.timestamp, data: location });
  });
});

app.get('/location', async (req, reply) => {
  const locations = new PassThrough({objectMode: true});
  stream.pipe(locations, { end: false });
  reply.sse(locations);
  const location = await getLastLocation();
  locations.write({ id: location.properties.timestamp, data: location });
});

(async () => {
  const usingSocket = isNaN(parseInt(port));
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      try {
      // Attempt to listen on socket
        const server = await app.listen(port);
        // Try downgrade permissions
        if (usingSocket) {
          return fs.stat(__filename, function(err, stats) {
            if (err) throw err;
            fs.chown(port, stats.uid, stats.gid, (err, res) => {
              if (err) throw err;
              process.setuid(stats.uid);
            });
          });
        }
        console.log(`Server listening on ${port}`);
        return server;
      } catch (error) {
        // Remove existing socket
        if (error.code !== 'EADDRINUSE') throw error;
        fs.unlinkSync(port);
        continue;
      }
    } catch (error) {
      errors.push(error);
      console.log(`Failed listening attempt ${attempt}`, error.message);
      continue;
    }
  }
  throw errors[errors.length -1];
})();
