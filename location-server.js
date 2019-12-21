const mongo = require('mongodb');
const fastify = require('fastify');
const sse = require('sly-fastify-sse');
const { PassThrough } = require("stream");
const fs = require('fs');

const port = '/run/location.sock';
const app = fastify();
const client = mongo.MongoClient.connect('mongodb://hal9000.grid.robotjamie.com:27017');

app.register(sse);

const getLastLocation = async () => (await client).db('memory').collection('locations').findOne({
  $query: {}, $orderby: { 'properties.timestamp' : -1 }
});

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
  console.debug('user connected to event stream');
  const locations = new PassThrough({objectMode: true});
  stream.pipe(locations);
  reply.sse(locations);
  const location = await getLastLocation();
  locations.write({ id: location.properties.timestamp, data: location });
});


(async () => {
  // TODO test port indicated is a string
  // isNaN(parseInt(port));
  // app2.listen(9000, '0.0.0.0').then(() => console.log('listening on port 9000'));
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    console.log('attempt', attempt);
    try {
      try {
      // Attempt to listen on socket
        const server = await app.listen(port);
        // Try downgrade permissions
        return fs.stat(__filename, function(err, stats) {
          if (err) throw err;
          console.log('downgrading to', stats.uid, stats.gid);
          fs.chown(port, stats.uid, stats.gid, (err, res) => {
            if (err) throw err;
            console.log('Downgraded permissions', res);
            process.setuid(stats.uid);
            console.log('Set process');
          });
        });
        console.log(`Server listening on ${port}`);
        return server;
      } catch (error) {
        console.log('In use');
        // Remove existing socket
        if (error.code !== 'EADDRINUSE') throw error;
        fs.unlinkSync(port);
        continue;
      }
    } catch (error) {
      errors.push(error);
      continue;
    }
  }
  throw errors[errors.length -1];
})();
