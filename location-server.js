const mongo = require('mongodb');
const fastify = require('fastify');
const sse = require('sly-fastify-sse');
const randomizeLocation = require('randomize-location');
const { PassThrough } = require('stream');
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

const obfuscate = (geo, private) => {
  if (private) return geo;
  const coordinates = randomizeLocation({
    lat: geo.geometry.coordinates[1],
    long: geo.geometry.coordinates[0],
    radius: 1000,
    rand1: ((parseInt(geo._id, 16) * 9301 + 49297) % 233280) / 233280,
    rand2: ((new Date(geo.properties.timestamp) * 9301 + 49297) % 233280) / 233280,
  });
  return {
    type: geo.type,
    properties: {
      battery_state: geo.properties.battery_state,
      battery_level: geo.properties.battery_level,
    },
    geometry: {
      type: geo.geometry.type,
      coordinates: [coordinates.lat, coordinates.long],
    }
  }
}

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
  const sseRequest = req.headers.accept.split(',').includes('text/event-stream');
  const privateRequest = req.header['x-memory-private'] === 'true';
  const location = await getLastLocation();
  const data = obfuscate(location, privateRequest);
  if (sseRequest) {
    const locations = new PassThrough({objectMode: true});
    stream.pipe(locations, { end: false });
    reply.sse(locations);
    locations.write({ id: location.properties.timestamp, data });
  } else {
    reply.send(data);
  }

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
