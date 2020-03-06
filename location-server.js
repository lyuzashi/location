const mongo = require('mongodb');
const fastify = require('fastify');
const sse = require('sly-fastify-sse');
const cors = require('fastify-cors');
const randomizeLocation = require('randomize-location');
const EventEmitter = require('events');
const { PassThrough, Transform } = require('stream');
const fs = require('fs');

const port = process.env.PORT || '/run/location.sock';
const app = fastify();
const client = mongo.MongoClient.connect(process.env.MONGO_URL || 'mongodb://localhost:27017');

app.register(sse);
app.register(cors);

// Create index if it doesn't already exists
client.then(connection => connection.db('memory').collection('locations').createIndex({ 'properties.timestamp': -1 }));

const getLastLocation = async () => (await client).db('memory').collection('locations').find({})
  .sort({'properties.timestamp': -1}).limit(1).next();

const transform = geo => ({
  ...geo,
  properties: {
    ...geo.properties,
    timestamp: new Date(geo.properties.timestamp),
  },
});

const round = (value, step) => {
  const inv = 1.0 / step;
  return Math.round(value * inv) / inv;
}

const obfuscate = geo => {
  const coordinates = randomizeLocation({
    lat: geo.geometry.coordinates[1],
    long: geo.geometry.coordinates[0],
    radius: 555,
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
      coordinates: [
        round(coordinates.long, 0.05),
        round(coordinates.lat, 0.05)
      ],
    }
  }
}

const incomming = new EventEmitter();

app.post('/location', async (request, reply) => {
  reply.send({
    result: 'ok'
  });
  const db = (await client).db('memory');
  const locations = request.body.locations.map(transform);
  await db.collection('locations').insertMany(locations);
  request.body.trip && await db.collection('trips').insertOne(transform(request.body.trip));
  locations.forEach(location => {
    incomming.emit('location', { id: location.properties.timestamp, data: location });
  });
});

app.get('/location', async (req, reply) => {
  const sseRequest = req.headers.accept.split(',').includes('text/event-stream');
  const privateRequest = req.headers['x-memory-private'] === 'true';
  const location = await getLastLocation();
  if (sseRequest) {
    const locations = new Transform({objectMode: true});
    locations._transform = (chunk, encoding, callback) =>
      callback(null, privateRequest ? chunk : { ...chunk, data: obfuscate(chunk.data) });
    reply.sse(locations);
    locations.write({ id: location.properties.timestamp, data: location });
    const handler = event => locations.write(event);
    incomming.on('location', handler);
    locations.once('end', () => {
      console.log('Closed');
      incomming.off('location', handler);
    })
  } else {
    reply.send(privateRequest ? location : obfuscate(location));
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
