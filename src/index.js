const _ = require('lodash');

class ServerlessIntegrationRequest {
  constructor(serverless, options) {
    this.serverless = serverless;
    _.each(serverless.pluginManager.plugins, (value, key) => {
      if (value.constructor.name === "AwsCompileApigEvents") {
        this.getIntegrationRequestTemplates = value.getIntegrationRequestTemplates;
        this.getIntegrationResponses = value.getIntegrationResponses;
        value.getMethodIntegration = this.getMethodIntegration;
        value.getIntegrationRequestParameters = this.getIntegrationRequestParameters;
        value.validate = this.validate;
      }
    });
  }

  getMethodIntegration(http, lambdaLogicalId) {
    const type = http.integration || 'AWS_PROXY';
    const integration = {
      IntegrationHttpMethod: 'POST',
      Type: type,
    };
    // Valid integrations are:
    // * `HTTP` for integrating with an HTTP back end,
    // * `AWS` for any AWS service endpoints,
    // * `MOCK` for testing without actually invoking the back end,
    // * `HTTP_PROXY` for integrating with the HTTP proxy integration, or
    // * `AWS_PROXY` for integrating with the Lambda proxy integration type (the default)
    if (type === 'AWS' || type === 'AWS_PROXY') {
      _.assign(integration, {
        Uri: {
          'Fn::Join': ['',
            [
              'arn:aws:apigateway:',
              { Ref: 'AWS::Region' },
              ':lambda:path/2015-03-31/functions/',
              { 'Fn::GetAtt': [lambdaLogicalId, 'Arn'] },
              '/invocations',
            ],
          ],
        },
      });
    } else if (type === 'HTTP' || type === 'HTTP_PROXY') {
      _.assign(integration, {
        Uri: http.request && http.request.uri,
        IntegrationHttpMethod: _.toUpper((http.request && http.request.method) || http.method),
      });
    } else if (type === 'MOCK') {
      // nothing to do but kept here for reference
    }

    if (type === 'AWS' || type === 'HTTP' || type === 'MOCK') {
      _.assign(integration, {
        PassthroughBehavior: http.request && http.request.passThrough,
        RequestTemplates: this.getIntegrationRequestTemplates(http, type === 'AWS'),
        IntegrationResponses: this.getIntegrationResponses(http),
      });
    }

    if ((type === 'AWS' || type === 'HTTP' || type === 'HTTP_PROXY') &&
      (http.request && (!_.isEmpty(http.request.parameters) || !_.isEmpty(http.request.integrations)))) {
      _.assign(integration, {
        RequestParameters: this.getIntegrationRequestParameters(http),
      });
    }

    return {
      Properties: {
        Integration: integration,
      },
    };
  }

    getIntegrationRequestParameters(http) {
        const parameters = {};
        if (http.request && http.request.parameters) {
          _.each(http.request.parameters, (value, key) => {
            parameters[`integration.${key.substring('method.'.length)}`] = key;
          });
        }
    
        if (http.request && http.request.integrations) {
          _.each(http.request.integrations, (value, key) => {
            parameters[key] = value;
          });
        }
        return parameters;
    }

    validate() {
        const events = [];
        const corsPreflight = {};
    
        _.forEach(this.serverless.service.functions, (functionObject, functionName) => {
          _.forEach(functionObject.events, (event) => {
            if (_.has(event, 'http')) {
              const http = this.getHttp(event, functionName);
    
              http.path = this.getHttpPath(http, functionName);
              http.method = this.getHttpMethod(http, functionName);
    
              if (http.authorizer) {
                http.authorizer = this.getAuthorizer(http, functionName);
              }
    
              if (http.cors) {
                http.cors = this.getCors(http);
    
                const cors = corsPreflight[http.path] || {};
    
                cors.headers = _.union(http.cors.headers, cors.headers);
                cors.methods = _.union(http.cors.methods, cors.methods);
                cors.origins = _.union(http.cors.origins, cors.origins);
                cors.origin = http.cors.origin || '*';
                cors.allowCredentials = cors.allowCredentials || http.cors.allowCredentials;
    
                corsPreflight[http.path] = cors;
              }
    
              http.integration = this.getIntegration(http, functionName);
    
              if ((http.integration === 'HTTP' || http.integration === 'HTTP_PROXY') &&
                (!http.request || !http.request.uri)) {
                const errorMessage = [
                  `You need to set the request uri when using the ${http.integration} integration.`,
                ];
                throw new this.serverless.classes.Error(errorMessage);
              }
    
              if (http.integration === 'AWS' || http.integration === 'HTTP') {
                http.request = this.getRequest(http);
                http.request.passThrough = this.getRequestPassThrough(http);
                http.response = this.getResponse(http);
                if (http.integration === 'AWS' && _.isEmpty(http.response)) {
                  http.response = {
                    statusCodes: DEFAULT_STATUS_CODES,
                  };
                }
              } else if (http.integration === 'AWS_PROXY' || http.integration === 'HTTP_PROXY') {
                // show a warning when request / response config is used with AWS_PROXY (LAMBDA-PROXY)
                if (http.request) {
                  const keys = Object.keys(http.request);
                  const allowedKeys =
                    http.integration === 'AWS_PROXY' ? ['parameters', 'integrations'] : ['parameters', 'integrations', 'uri'];
    
                  if (!_.isEmpty(_.difference(keys, allowedKeys))) {
                    const requestWarningMessage = [
                      `Warning! You're using the ${http.integration} in combination with a request`,
                      ` configuration in your function "${functionName}". Only the `,
                      _.map(allowedKeys, value => `request.${value}`).join(', '),
                      ` configs are available in conjunction with ${http.integration}.`,
                      ' Serverless will remove this configuration automatically',
                      ' before deployment.',
                    ].join('');
                    this.serverless.cli.log(requestWarningMessage);
                    for (const key of keys) {
                      if (!_.includes(allowedKeys, key)) {
                        delete http.request[key];
                      }
                    }
                  }
                  if (Object.keys(http.request).length === 0) {
                    // No keys left, delete the request object
                    delete http.request;
                  } else {
                    http.request = this.getRequest(http);
                  }
                }
                if (http.response) {
                  const warningMessage = [
                    `Warning! You're using the ${http.integration} in combination with response`,
                    ` configuration in your function "${functionName}".`,
                    ' Serverless will remove this configuration automatically before deployment.',
                  ].join('');
                  this.serverless.cli.log(warningMessage);
    
                  delete http.response;
                }
              }
    
              events.push({
                functionName,
                http,
              });
            }
          });
        });
    
        return {
          events,
          corsPreflight,
        };
    }
}

module.exports = ServerlessIntegrationRequest;