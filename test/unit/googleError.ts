/**
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import {describe, it} from 'mocha';
import * as fs from 'fs';
import * as util from 'util';
import * as protobuf from 'protobufjs';
import * as path from 'path';
import {GoogleError, GoogleErrorDecoder} from '../../src/googleError';
import {Metadata} from '@grpc/grpc-js';

interface MyObj {
  type: string;
  value: protobuf.Message<{}>;
}

describe('gRPC-google error decoding', () => {
  const fixtureName = path.resolve(
    __dirname,
    '..',
    'fixtures',
    'multipleErrors.json'
  );
  const protos_path = path.resolve(
    __dirname,
    '..',
    '..',
    'protos',
    'google',
    'rpc'
  );
  const root = protobuf.loadSync([
    path.join(protos_path, 'error_details.proto'),
    path.join(protos_path, 'status.proto'),
  ]);

  it('decodes multiple errors', async () => {
    // example of when there are multiple errors available to be decoded
    const expectedErrorArr = [] as protobuf.Message<{}>[];
    const decoder = new GoogleErrorDecoder();
    const readFile = util.promisify(fs.readFile);

    const data = await readFile(fixtureName, 'utf8');
    const objs = JSON.parse(data) as MyObj[];
    const details = [];
    for (const obj of objs) {
      const MessageType = root.lookupType(obj.type);
      expectedErrorArr.push(obj.value);
      const buffer = MessageType.encode(obj.value).finish() as Buffer;
      const anyObj = {
        type_url: 'type.googleapis.com/' + obj.type,
        value: buffer,
      };
      details.push(anyObj);
    }
    const status = {code: 3, message: 'test', details: details};
    const Status = root.lookupType('google.rpc.Status');
    const statusBuffer = Status.encode(status).finish() as Buffer;
    const gRPCStatusDetailsObj = decoder.decodeGRPCStatusDetails(
      new Array(statusBuffer)
    );
    assert.strictEqual(
      JSON.stringify(expectedErrorArr),
      JSON.stringify(gRPCStatusDetailsObj.details)
    );
    assert.deepStrictEqual(
      JSON.stringify(gRPCStatusDetailsObj.errorInfo),
      JSON.stringify(
        objs.find(item => item.type === 'google.rpc.ErrorInfo')?.value
      )
    );
  });

  it('does not decode when no error exists', () => {
    // example of when there's no grpc-error available to be decoded
    const emptyBuffer: Buffer = Buffer.from('');
    const decoder = new GoogleErrorDecoder();

    const gRPCStatusDetailsObj = decoder.decodeGRPCStatusDetails(
      new Array(emptyBuffer)
    );

    // nested error messages have different types so we can't use deepStrictEqual here
    assert.strictEqual(
      JSON.stringify(gRPCStatusDetailsObj.details),
      JSON.stringify([])
    );
    assert.strictEqual(gRPCStatusDetailsObj.errorInfo, undefined);
  });

  it('DecodeRpcStatus does not fail when unknown type is encoded', () => {
    const any = {type_url: 'noMatch', value: new Uint8Array()};
    const status = {code: 3, message: 'test', details: [any]};
    const Status = root.lookupType('google.rpc.Status');
    const status_buffer = Status.encode(status).finish();
    const decoder = new GoogleErrorDecoder();

    const decodedError = decoder.decodeRpcStatus(status_buffer);

    assert.strictEqual(
      JSON.stringify(decodedError),
      '{"code":3,"message":"test","details":[]}'
    );
  });

  it('DecodeRpcStatusDetails does not fail when unknown type is encoded', () => {
    const any = {type_url: 'noMatch', value: new Uint8Array()};
    const status = {code: 3, message: 'test', details: [any]};
    const Status = root.lookupType('google.rpc.Status');
    const status_buffer = Status.encode(status).finish();
    const decoder = new GoogleErrorDecoder();

    const gRPCStatusDetailsObj = decoder.decodeGRPCStatusDetails(
      new Array(status_buffer)
    );

    assert.strictEqual(
      JSON.stringify(gRPCStatusDetailsObj.details),
      JSON.stringify([])
    );
  });

  it('does not decode when unknown type is encoded in type_url', () => {
    // example of when error details' type_url doesn't match "type.googleapis.com"
    const decoder = new GoogleErrorDecoder();
    const any = {type_url: 'noMatch', value: new Uint8Array()};

    try {
      decoder.decodeProtobufAny(any);
    } catch (err) {
      assert.strictEqual(
        0,
        err
          .toString()
          .indexOf('Error: Unknown type encoded in google.protobuf.any:')
      );
    }
  });

  it('does not decode when error type does not exist under "type.googleapis.com" ', () => {
    // example of when error details' type_url = "type.googleapis.com/{errType}" and errType is invalid
    const decoder = new GoogleErrorDecoder();
    const any = {
      type_url: 'type.googleapis.com/noMatch',
      value: new Uint8Array(),
    };

    try {
      decoder.decodeProtobufAny(any);
    } catch (err) {
      assert.strictEqual(0, err.toString().indexOf('Error: no such type'));
    }
  });
});

describe('parse grpc status details with ErrorInfo from grpc metadata', () => {
  it('metadata contains key grpc-status-details-bin with ErrorInfo', async () => {
    const errorInfoObj = {
      metadata: {
        consumer: 'projects/455411330361',
        service: 'translate.googleapis.com',
      },
      reason: 'SERVICE_DISABLED',
      domain: 'googleapis.com',
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const errorProtoJson = require('../../protos/status.json');
    const root = protobuf.Root.fromJSON(errorProtoJson);
    const errorInfoType = root.lookupType('ErrorInfo');
    const buffer = errorInfoType.encode(errorInfoObj).finish() as Buffer;
    const any = {
      type_url: 'type.googleapis.com/google.rpc.ErrorInfo',
      value: buffer,
    };
    const status = {code: 3, message: 'test', details: [any]};
    const Status = root.lookupType('google.rpc.Status');
    const status_buffer = Status.encode(status).finish() as Buffer;
    const metadata = new Metadata();
    metadata.set('grpc-status-details-bin', status_buffer);
    const grpcError = Object.assign(
      new GoogleError('mock error with ErrorInfo'),
      {
        code: 7,
        metadata: metadata,
      }
    );
    const decodedError = GoogleError.parseGRPCStatusDetails(grpcError);
    assert(decodedError instanceof GoogleError);
    assert.strictEqual(decodedError.domain, errorInfoObj.domain);
    assert.strictEqual(decodedError.reason, errorInfoObj.reason);
    for (const [key, value] of Object.entries(errorInfoObj.metadata)) {
      assert.ok(decodedError.metadata);
      assert.strictEqual(
        (decodedError.metadata.get(key) as Array<string>).shift(),
        value
      );
    }
  });
  it('metadata has no key grpc-status-details-bin', async () => {
    const metadata = new Metadata();
    metadata.set('grpc-server-stats-bin', Buffer.from('AAKENLPQKNSALSDFJ'));
    const grpcError = Object.assign(
      new GoogleError('mock error with metadata'),
      {
        code: 7,
        metadata: metadata,
      }
    );
    const decodedError = GoogleError.parseGRPCStatusDetails(grpcError);
    assert(decodedError instanceof GoogleError);
    assert.strictEqual(decodedError, grpcError);
  });
  it('no grpc metadata', async () => {
    const grpcError = Object.assign(
      new GoogleError('mock error without metadata'),
      {
        code: 7,
      }
    );
    const decodedError = GoogleError.parseGRPCStatusDetails(grpcError);
    assert(decodedError instanceof GoogleError);
    assert.strictEqual(decodedError, grpcError);
  });
});