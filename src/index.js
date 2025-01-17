/* eslint-disable security/detect-non-literal-fs-filename */
// Libraries
const IotAgent = require('@dojot/iotagent-nodejs');
const { logger } = require('@dojot/dojot-module-logger');
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const tls = require('tls');
const config = require('./config');

let attempts = 0;

// set log level
logger.setLevel(config.log_level);

// Initialize the IoT Agent.
const iotAgent = new IotAgent.IoTAgent();

iotAgent
  .init()
  .then(() => {
    logger.info('Succeeded to start the HTTP IoT Agent ');

    // HTTP app
    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // handle HTTP post
    app.post('/iotagent/readings', (req, res) => {
      logger.debug(`Received HTTP message: ${JSON.stringify(req.body)}`);

      const { body } = req;
      let tenant;
      let deviceId;

      if (req.socket instanceof tls.TLSSocket) {
        // retrieve certificates from the request ( in der format )
        const clientCert = req.socket.getPeerCertificate();
        if (
          !Object.prototype.hasOwnProperty.call(clientCert, 'subject')
          || !Object.hasOwnProperty.bind(clientCert.subject)('CN')
        ) {
          logger.error('Client certificate is invalid.');
          res.status(401).send({ message: 'Client certificate is invalid.' });
          return;
        }
        if (
          Object.prototype.hasOwnProperty.call(body, 'deviceId')
          && Object.prototype.hasOwnProperty.call(body, 'tenant')
        ) {
          deviceId = body.deviceId;
          tenant = body.tenant;
          // validate if the message belongs to same device than certificate
          if (clientCert.subject.CN !== `${tenant}:${deviceId}`) {
            logger.error(
              `Connection rejected for ${deviceId} due to invalid client certificate. The tenant and deviceid sent in the body are not the same as the certificate.`,
            );
            res.status(401).send({
              message: `Connection rejected for ${deviceId} due to invalid client certificate. The tenant and deviceid sent in the body are not the same as the certificate.`,
            });
            return;
          }
        } else {
          const cn = clientCert.subject.CN;
          try {
            const cnArray = cn.split(':');
            [tenant, deviceId] = cnArray;
          } catch (err) {
            logger.error(
              'Error trying to get tenant and deviceId in CN of certificate.',
              err,
            );
            res.status(401).send({
              message:
                'Error trying to get tenant and deviceId in CN of certificate.',
            });
          }
        }
      } else {
        if (
          !Object.prototype.hasOwnProperty.call(body, 'deviceId')
          || !Object.prototype.hasOwnProperty.call(body, 'tenant')
        ) {
          logger.error('Missing attribute tenant or deviceId');
          res
            .status(401)
            .send({ message: 'Missing attribute tenant or deviceId' });
          return;
        }

        deviceId = body.deviceId;
        tenant = body.tenant;
      }

      if (!Object.prototype.hasOwnProperty.call(body, 'readings')) {
        res.status(400).send({ message: 'Missing attribute readings' });
        return;
      }
      const { readings } = body;

      readings.forEach((reading) => {
        const newReading = reading;
        const metadata = {};
        try {
          metadata.timestamp = Date.parse(newReading.timestamp);
        } catch (err) {
          metadata.timestamp = new Date().getTime();
        }
        delete newReading.timestamp;
        const msg = { ...newReading };

        msg.device = deviceId;

        logger.debug(
          `${deviceId}, ${tenant}, ${JSON.stringify(msg)}, ${JSON.stringify({
            ...metadata,
          })}`,
        );

        // send data to dojot internal services
        iotAgent.updateAttrs(deviceId, tenant, msg, { ...metadata });
      });

      logger.info('Message published successfully.');
      res.status(200).send({ message: 'Successfully published' });
    });

    const httpsServer = https.createServer(
      {
        cert: fs.readFileSync(`${config.http_tls.cert}`),
        key: fs.readFileSync(`${config.http_tls.key}`),
        ca: fs.readFileSync(`${config.http_tls.ca}`),
        rejectUnauthorized: true,
        requestCert: true,
      },
      app,
    );

    const reloadCertificates = (interval) => {
      try {
        httpsServer.setSecureContext({
          cert: fs.readFileSync(`${config.http_tls.cert}`),
          key: fs.readFileSync(`${config.http_tls.key}`),
          ca: fs.readFileSync(`${config.http_tls.ca}`),
          crl: fs.readFileSync(`${config.http_tls.crl}`),
        });
        logger.debug('Seted new secure context!');
        clearInterval(interval);
      } catch (err) {
        if (attempts < config.reload_certificates.attempts) {
          attempts += 1;
        } else {
          logger.error('New secure context cannot be Seted!', err);
          process.kill(process.pid, 'SIGTERM');
        }
      }
    };

    fs.watch(`${config.http_cert_directory}`, (eventType, filename) => {
      logger.debug(`${eventType}: The ${filename} was modified!`);
      const interval = setInterval(() => {
        reloadCertificates(interval);
      }, config.reload_certificates.interval_ms);
    });

    // start HTTPS app
    httpsServer.listen(config.server_port.https, () => {
      logger.info(
        `IotAgent HTTPS listening on port ${config.server_port.https}!`,
      );
    });

    if (config.allow_unsecured_mode) {
      const httpServer = http.createServer(app);

      // start HTTP app
      httpServer.listen(config.server_port.http, () => {
        logger.info(
          `IotAgent HTTP listening on port ${config.server_port.http}!`,
        );
      });
    }
  })
  .catch((error) => {
    logger.error(`Failed to initialize the HTTP IoT Agent (${error})`);
    process.kill(process.pid, 'SIGTERM');
  });
