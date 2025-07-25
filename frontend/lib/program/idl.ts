export type SolanaCoreContracts = {
  address: 'GDMMWC3YiZEffb2u5dw6FTLRY5wV5vAcXP72LRAJaVhK';
  metadata: {
    name: 'solanaCoreContracts';
    version: '0.1.0';
    spec: '0.1.0';
    description: 'Created with Anchor';
  };
  instructions: [
    {
      name: 'claimErc20';
      discriminator: [137, 119, 173, 96, 103, 202, 227, 33];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'pendingDeposit';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  101,
                  114,
                  99,
                  50,
                  48,
                  95,
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116,
                ];
              },
              {
                kind: 'arg';
                path: 'requestId';
              },
            ];
          };
        },
        {
          name: 'userBalance';
          writable: true;
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'requestId';
          type: {
            array: ['u8', 32];
          };
        },
        {
          name: 'serializedOutput';
          type: 'bytes';
        },
        {
          name: 'signature';
          type: {
            defined: {
              name: 'signature';
            };
          };
        },
      ];
    },
    {
      name: 'completeWithdrawErc20';
      discriminator: [108, 220, 227, 17, 212, 248, 163, 74];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'pendingWithdrawal';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  101,
                  114,
                  99,
                  50,
                  48,
                  95,
                  119,
                  105,
                  116,
                  104,
                  100,
                  114,
                  97,
                  119,
                  97,
                  108,
                ];
              },
              {
                kind: 'arg';
                path: 'requestId';
              },
            ];
          };
        },
        {
          name: 'userBalance';
          writable: true;
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'requestId';
          type: {
            array: ['u8', 32];
          };
        },
        {
          name: 'serializedOutput';
          type: 'bytes';
        },
        {
          name: 'signature';
          type: {
            defined: {
              name: 'signature';
            };
          };
        },
      ];
    },
    {
      name: 'depositErc20';
      discriminator: [22, 2, 82, 3, 29, 137, 71, 85];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'requester';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121,
                ];
              },
              {
                kind: 'account';
                path: 'authority';
              },
            ];
          };
        },
        {
          name: 'pendingDeposit';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  101,
                  114,
                  99,
                  50,
                  48,
                  95,
                  100,
                  101,
                  112,
                  111,
                  115,
                  105,
                  116,
                ];
              },
              {
                kind: 'arg';
                path: 'requestId';
              },
            ];
          };
        },
        {
          name: 'feePayer';
          writable: true;
          signer: true;
          optional: true;
        },
        {
          name: 'chainSignaturesState';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101,
                ];
              },
            ];
            program: {
              kind: 'account';
              path: 'chainSignaturesProgram';
            };
          };
        },
        {
          name: 'chainSignaturesProgram';
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'instructions';
          optional: true;
        },
      ];
      args: [
        {
          name: 'requestId';
          type: {
            array: ['u8', 32];
          };
        },
        {
          name: 'erc20Address';
          type: {
            array: ['u8', 20];
          };
        },
        {
          name: 'amount';
          type: 'u128';
        },
        {
          name: 'txParams';
          type: {
            defined: {
              name: 'evmTransactionParams';
            };
          };
        },
      ];
    },
    {
      name: 'processDeposit';
      discriminator: [136, 162, 64, 35, 84, 200, 254, 136];
      accounts: [];
      args: [
        {
          name: 'tx';
          type: {
            defined: {
              name: 'vaultTransaction';
            };
          };
        },
      ];
      returns: {
        array: ['u8', 32];
      };
    },
    {
      name: 'processWithdraw';
      discriminator: [166, 189, 47, 170, 19, 135, 210, 19];
      accounts: [];
      args: [
        {
          name: 'tx';
          type: {
            defined: {
              name: 'vaultTransaction';
            };
          };
        },
      ];
      returns: {
        array: ['u8', 32];
      };
    },
    {
      name: 'signDepositTransaction';
      discriminator: [100, 76, 194, 203, 93, 232, 38, 86];
      accounts: [
        {
          name: 'authority';
          docs: ['The user authority that owns this vault'];
          signer: true;
        },
        {
          name: 'requester';
          docs: [
            'User-specific vault authority PDA that acts as the requester',
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121,
                ];
              },
              {
                kind: 'account';
                path: 'authority';
              },
            ];
          };
        },
        {
          name: 'feePayer';
          docs: ['Optional separate account to pay signature fees'];
          writable: true;
          signer: true;
          optional: true;
        },
        {
          name: 'chainSignaturesState';
          docs: ['Chain signatures program state account'];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101,
                ];
              },
            ];
            program: {
              kind: 'account';
              path: 'chainSignaturesProgram';
            };
          };
        },
        {
          name: 'chainSignaturesProgram';
          docs: ['The chain signatures program'];
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'instructions';
          optional: true;
        },
      ];
      args: [
        {
          name: 'tx';
          type: {
            defined: {
              name: 'vaultTransaction';
            };
          };
        },
        {
          name: 'signingParams';
          type: {
            defined: {
              name: 'signingParams';
            };
          };
        },
      ];
    },
    {
      name: 'signWithdrawTransaction';
      discriminator: [166, 131, 86, 20, 105, 71, 176, 253];
      accounts: [
        {
          name: 'authority';
          docs: ['The user authority that owns this vault'];
          signer: true;
        },
        {
          name: 'requester';
          docs: [
            'User-specific vault authority PDA that acts as the requester',
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121,
                ];
              },
              {
                kind: 'account';
                path: 'authority';
              },
            ];
          };
        },
        {
          name: 'feePayer';
          docs: ['Optional separate account to pay signature fees'];
          writable: true;
          signer: true;
          optional: true;
        },
        {
          name: 'chainSignaturesState';
          docs: ['Chain signatures program state account'];
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101,
                ];
              },
            ];
            program: {
              kind: 'account';
              path: 'chainSignaturesProgram';
            };
          };
        },
        {
          name: 'chainSignaturesProgram';
          docs: ['The chain signatures program'];
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'instructions';
          optional: true;
        },
      ];
      args: [
        {
          name: 'tx';
          type: {
            defined: {
              name: 'vaultTransaction';
            };
          };
        },
        {
          name: 'signingParams';
          type: {
            defined: {
              name: 'signingParams';
            };
          };
        },
      ];
    },
    {
      name: 'withdrawErc20';
      discriminator: [19, 124, 28, 31, 171, 187, 87, 70];
      accounts: [
        {
          name: 'authority';
          writable: true;
          signer: true;
        },
        {
          name: 'requester';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121,
                ];
              },
            ];
          };
        },
        {
          name: 'pendingWithdrawal';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  101,
                  114,
                  99,
                  50,
                  48,
                  95,
                  119,
                  105,
                  116,
                  104,
                  100,
                  114,
                  97,
                  119,
                  97,
                  108,
                ];
              },
              {
                kind: 'arg';
                path: 'requestId';
              },
            ];
          };
        },
        {
          name: 'userBalance';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  117,
                  115,
                  101,
                  114,
                  95,
                  101,
                  114,
                  99,
                  50,
                  48,
                  95,
                  98,
                  97,
                  108,
                  97,
                  110,
                  99,
                  101,
                ];
              },
              {
                kind: 'account';
                path: 'authority';
              },
              {
                kind: 'arg';
                path: 'erc20Address';
              },
            ];
          };
        },
        {
          name: 'feePayer';
          writable: true;
          signer: true;
          optional: true;
        },
        {
          name: 'chainSignaturesState';
          writable: true;
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  45,
                  115,
                  116,
                  97,
                  116,
                  101,
                ];
              },
            ];
            program: {
              kind: 'account';
              path: 'chainSignaturesProgram';
            };
          };
        },
        {
          name: 'chainSignaturesProgram';
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU';
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
        {
          name: 'instructions';
          optional: true;
        },
      ];
      args: [
        {
          name: 'requestId';
          type: {
            array: ['u8', 32];
          };
        },
        {
          name: 'erc20Address';
          type: {
            array: ['u8', 20];
          };
        },
        {
          name: 'amount';
          type: 'u128';
        },
        {
          name: 'recipientAddress';
          type: {
            array: ['u8', 20];
          };
        },
        {
          name: 'txParams';
          type: {
            defined: {
              name: 'evmTransactionParams';
            };
          };
        },
      ];
    },
  ];
  accounts: [
    {
      name: 'pendingErc20Deposit';
      discriminator: [214, 238, 68, 242, 98, 102, 251, 178];
    },
    {
      name: 'pendingErc20Withdrawal';
      discriminator: [33, 60, 7, 188, 11, 40, 41, 150];
    },
    {
      name: 'userErc20Balance';
      discriminator: [29, 16, 203, 40, 208, 43, 221, 11];
    },
  ];
  errors: [
    {
      code: 6000;
      name: 'invalidChainSignaturesProgram';
      msg: 'Invalid chain signatures program';
    },
    {
      code: 6001;
      name: 'serializationError';
      msg: 'Serialization error';
    },
    {
      code: 6002;
      name: 'functionNotFound';
      msg: 'Function not found in ABI';
    },
    {
      code: 6003;
      name: 'invalidRequestId';
      msg: 'Invalid request ID';
    },
    {
      code: 6004;
      name: 'invalidSignature';
      msg: 'Invalid signature';
    },
    {
      code: 6005;
      name: 'transferFailed';
      msg: 'Transfer failed';
    },
    {
      code: 6006;
      name: 'invalidOutput';
      msg: 'Invalid output format';
    },
    {
      code: 6007;
      name: 'overflow';
      msg: 'Arithmetic overflow';
    },
    {
      code: 6008;
      name: 'invalidAddress';
      msg: 'Invalid address';
    },
    {
      code: 6009;
      name: 'schemaTooLarge';
      msg: 'Schema size exceeds maximum allowed';
    },
    {
      code: 6010;
      name: 'insufficientBalance';
      msg: 'Insufficient balance';
    },
    {
      code: 6011;
      name: 'underflow';
      msg: 'Underflow error';
    },
  ];
  types: [
    {
      name: 'affinePoint';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'x';
            type: {
              array: ['u8', 32];
            };
          },
          {
            name: 'y';
            type: {
              array: ['u8', 32];
            };
          },
        ];
      };
    },
    {
      name: 'evmTransactionParams';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'value';
            type: 'u128';
          },
          {
            name: 'gasLimit';
            type: 'u128';
          },
          {
            name: 'maxFeePerGas';
            type: 'u128';
          },
          {
            name: 'maxPriorityFeePerGas';
            type: 'u128';
          },
          {
            name: 'nonce';
            type: 'u64';
          },
          {
            name: 'chainId';
            type: 'u64';
          },
        ];
      };
    },
    {
      name: 'pendingErc20Deposit';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'requester';
            type: 'pubkey';
          },
          {
            name: 'amount';
            type: 'u128';
          },
          {
            name: 'erc20Address';
            type: {
              array: ['u8', 20];
            };
          },
          {
            name: 'path';
            type: 'string';
          },
          {
            name: 'requestId';
            type: {
              array: ['u8', 32];
            };
          },
        ];
      };
    },
    {
      name: 'pendingErc20Withdrawal';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'requester';
            type: 'pubkey';
          },
          {
            name: 'amount';
            type: 'u128';
          },
          {
            name: 'erc20Address';
            type: {
              array: ['u8', 20];
            };
          },
          {
            name: 'recipientAddress';
            type: {
              array: ['u8', 20];
            };
          },
          {
            name: 'path';
            type: 'string';
          },
          {
            name: 'requestId';
            type: {
              array: ['u8', 32];
            };
          },
        ];
      };
    },
    {
      name: 'signature';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'bigR';
            type: {
              defined: {
                name: 'affinePoint';
              };
            };
          },
          {
            name: 's';
            type: {
              array: ['u8', 32];
            };
          },
          {
            name: 'recoveryId';
            type: 'u8';
          },
        ];
      };
    },
    {
      name: 'signingParams';
      docs: [
        'Parameters for requesting a signature from the chain signatures program',
      ];
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'keyVersion';
            docs: ['Version of the key to use for signing'];
            type: 'u32';
          },
          {
            name: 'path';
            docs: ['Derivation path for the key (e.g., "ethereum,1")'];
            type: 'string';
          },
          {
            name: 'algo';
            docs: ['Signing algorithm (e.g., "secp256k1")'];
            type: 'string';
          },
          {
            name: 'dest';
            docs: ['Destination identifier'];
            type: 'string';
          },
          {
            name: 'params';
            docs: ['Additional parameters as JSON string'];
            type: 'string';
          },
        ];
      };
    },
    {
      name: 'userErc20Balance';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'amount';
            type: 'u128';
          },
        ];
      };
    },
    {
      name: 'vaultTransaction';
      docs: ['Represents a vault transaction to be processed'];
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'toAddress';
            docs: ['EVM contract address to call'];
            type: {
              array: ['u8', 20];
            };
          },
          {
            name: 'value';
            docs: ['Amount of ETH to send with the transaction'];
            type: 'u128';
          },
          {
            name: 'gasLimit';
            docs: ['Gas limit for the transaction'];
            type: 'u128';
          },
          {
            name: 'maxFeePerGas';
            docs: ['Maximum fee per gas unit'];
            type: 'u128';
          },
          {
            name: 'maxPriorityFeePerGas';
            docs: ['Maximum priority fee per gas unit'];
            type: 'u128';
          },
          {
            name: 'nonce';
            docs: ['Transaction nonce'];
            type: 'u64';
          },
          {
            name: 'chainId';
            docs: ['Chain ID for the target EVM network'];
            type: 'u64';
          },
          {
            name: 'recipientAddress';
            docs: ['Recipient address for the vault operation'];
            type: {
              array: ['u8', 20];
            };
          },
          {
            name: 'amount';
            docs: ['Amount to deposit or withdraw'];
            type: 'u128';
          },
        ];
      };
    },
  ];
};

export const IDL: SolanaCoreContracts = {
  address: 'GDMMWC3YiZEffb2u5dw6FTLRY5wV5vAcXP72LRAJaVhK',
  metadata: {
    name: 'solanaCoreContracts',
    version: '0.1.0',
    spec: '0.1.0',
    description: 'Created with Anchor',
  },
  instructions: [
    {
      name: 'claimErc20',
      discriminator: [137, 119, 173, 96, 103, 202, 227, 33],
      accounts: [
        {
          name: 'authority',
          writable: true,
          signer: true,
        },
        {
          name: 'pendingDeposit',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 101, 110, 100, 105, 110, 103, 95, 101, 114, 99, 50, 48,
                  95, 100, 101, 112, 111, 115, 105, 116,
                ],
              },
              {
                kind: 'arg',
                path: 'requestId',
              },
            ],
          },
        },
        {
          name: 'userBalance',
          writable: true,
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
      ],
      args: [
        {
          name: 'requestId',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'serializedOutput',
          type: 'bytes',
        },
        {
          name: 'signature',
          type: {
            defined: {
              name: 'signature',
            },
          },
        },
      ],
    },
    {
      name: 'completeWithdrawErc20',
      discriminator: [108, 220, 227, 17, 212, 248, 163, 74],
      accounts: [
        {
          name: 'authority',
          writable: true,
          signer: true,
        },
        {
          name: 'pendingWithdrawal',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 101, 110, 100, 105, 110, 103, 95, 101, 114, 99, 50, 48,
                  95, 119, 105, 116, 104, 100, 114, 97, 119, 97, 108,
                ],
              },
              {
                kind: 'arg',
                path: 'requestId',
              },
            ],
          },
        },
        {
          name: 'userBalance',
          writable: true,
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
      ],
      args: [
        {
          name: 'requestId',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'serializedOutput',
          type: 'bytes',
        },
        {
          name: 'signature',
          type: {
            defined: {
              name: 'signature',
            },
          },
        },
      ],
    },
    {
      name: 'depositErc20',
      discriminator: [22, 2, 82, 3, 29, 137, 71, 85],
      accounts: [
        {
          name: 'authority',
          writable: true,
          signer: true,
        },
        {
          name: 'requester',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 97, 117, 116, 104, 111, 114, 105,
                  116, 121,
                ],
              },
              {
                kind: 'account',
                path: 'authority',
              },
            ],
          },
        },
        {
          name: 'pendingDeposit',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 101, 110, 100, 105, 110, 103, 95, 101, 114, 99, 50, 48,
                  95, 100, 101, 112, 111, 115, 105, 116,
                ],
              },
              {
                kind: 'arg',
                path: 'requestId',
              },
            ],
          },
        },
        {
          name: 'feePayer',
          writable: true,
          signer: true,
          optional: true,
        },
        {
          name: 'chainSignaturesState',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 114, 111, 103, 114, 97, 109, 45, 115, 116, 97, 116, 101,
                ],
              },
            ],
            program: {
              kind: 'account',
              path: 'chainSignaturesProgram',
            },
          },
        },
        {
          name: 'chainSignaturesProgram',
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU',
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
        {
          name: 'instructions',
          optional: true,
        },
      ],
      args: [
        {
          name: 'requestId',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'erc20Address',
          type: {
            array: ['u8', 20],
          },
        },
        {
          name: 'amount',
          type: 'u128',
        },
        {
          name: 'txParams',
          type: {
            defined: {
              name: 'evmTransactionParams',
            },
          },
        },
      ],
    },
    {
      name: 'processDeposit',
      discriminator: [136, 162, 64, 35, 84, 200, 254, 136],
      accounts: [],
      args: [
        {
          name: 'tx',
          type: {
            defined: {
              name: 'vaultTransaction',
            },
          },
        },
      ],
      returns: {
        array: ['u8', 32],
      },
    },
    {
      name: 'processWithdraw',
      discriminator: [166, 189, 47, 170, 19, 135, 210, 19],
      accounts: [],
      args: [
        {
          name: 'tx',
          type: {
            defined: {
              name: 'vaultTransaction',
            },
          },
        },
      ],
      returns: {
        array: ['u8', 32],
      },
    },
    {
      name: 'signDepositTransaction',
      discriminator: [100, 76, 194, 203, 93, 232, 38, 86],
      accounts: [
        {
          name: 'authority',
          docs: ['The user authority that owns this vault'],
          signer: true,
        },
        {
          name: 'requester',
          docs: [
            'User-specific vault authority PDA that acts as the requester',
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 97, 117, 116, 104, 111, 114, 105,
                  116, 121,
                ],
              },
              {
                kind: 'account',
                path: 'authority',
              },
            ],
          },
        },
        {
          name: 'feePayer',
          docs: ['Optional separate account to pay signature fees'],
          writable: true,
          signer: true,
          optional: true,
        },
        {
          name: 'chainSignaturesState',
          docs: ['Chain signatures program state account'],
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 114, 111, 103, 114, 97, 109, 45, 115, 116, 97, 116, 101,
                ],
              },
            ],
            program: {
              kind: 'account',
              path: 'chainSignaturesProgram',
            },
          },
        },
        {
          name: 'chainSignaturesProgram',
          docs: ['The chain signatures program'],
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU',
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
        {
          name: 'instructions',
          optional: true,
        },
      ],
      args: [
        {
          name: 'tx',
          type: {
            defined: {
              name: 'vaultTransaction',
            },
          },
        },
        {
          name: 'signingParams',
          type: {
            defined: {
              name: 'signingParams',
            },
          },
        },
      ],
    },
    {
      name: 'signWithdrawTransaction',
      discriminator: [166, 131, 86, 20, 105, 71, 176, 253],
      accounts: [
        {
          name: 'authority',
          docs: ['The user authority that owns this vault'],
          signer: true,
        },
        {
          name: 'requester',
          docs: [
            'User-specific vault authority PDA that acts as the requester',
          ],
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 97, 117, 116, 104, 111, 114, 105,
                  116, 121,
                ],
              },
              {
                kind: 'account',
                path: 'authority',
              },
            ],
          },
        },
        {
          name: 'feePayer',
          docs: ['Optional separate account to pay signature fees'],
          writable: true,
          signer: true,
          optional: true,
        },
        {
          name: 'chainSignaturesState',
          docs: ['Chain signatures program state account'],
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 114, 111, 103, 114, 97, 109, 45, 115, 116, 97, 116, 101,
                ],
              },
            ],
            program: {
              kind: 'account',
              path: 'chainSignaturesProgram',
            },
          },
        },
        {
          name: 'chainSignaturesProgram',
          docs: ['The chain signatures program'],
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU',
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
        {
          name: 'instructions',
          optional: true,
        },
      ],
      args: [
        {
          name: 'tx',
          type: {
            defined: {
              name: 'vaultTransaction',
            },
          },
        },
        {
          name: 'signingParams',
          type: {
            defined: {
              name: 'signingParams',
            },
          },
        },
      ],
    },
    {
      name: 'withdrawErc20',
      discriminator: [19, 124, 28, 31, 171, 187, 87, 70],
      accounts: [
        {
          name: 'authority',
          writable: true,
          signer: true,
        },
        {
          name: 'requester',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  103, 108, 111, 98, 97, 108, 95, 118, 97, 117, 108, 116, 95,
                  97, 117, 116, 104, 111, 114, 105, 116, 121,
                ],
              },
            ],
          },
        },
        {
          name: 'pendingWithdrawal',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 101, 110, 100, 105, 110, 103, 95, 101, 114, 99, 50, 48,
                  95, 119, 105, 116, 104, 100, 114, 97, 119, 97, 108,
                ],
              },
              {
                kind: 'arg',
                path: 'requestId',
              },
            ],
          },
        },
        {
          name: 'userBalance',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  117, 115, 101, 114, 95, 101, 114, 99, 50, 48, 95, 98, 97, 108,
                  97, 110, 99, 101,
                ],
              },
              {
                kind: 'account',
                path: 'authority',
              },
              {
                kind: 'arg',
                path: 'erc20Address',
              },
            ],
          },
        },
        {
          name: 'feePayer',
          writable: true,
          signer: true,
          optional: true,
        },
        {
          name: 'chainSignaturesState',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  112, 114, 111, 103, 114, 97, 109, 45, 115, 116, 97, 116, 101,
                ],
              },
            ],
            program: {
              kind: 'account',
              path: 'chainSignaturesProgram',
            },
          },
        },
        {
          name: 'chainSignaturesProgram',
          address: '4uvZW8K4g4jBg7dzPNbb9XDxJLFBK7V6iC76uofmYvEU',
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
        {
          name: 'instructions',
          optional: true,
        },
      ],
      args: [
        {
          name: 'requestId',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'erc20Address',
          type: {
            array: ['u8', 20],
          },
        },
        {
          name: 'amount',
          type: 'u128',
        },
        {
          name: 'recipientAddress',
          type: {
            array: ['u8', 20],
          },
        },
        {
          name: 'txParams',
          type: {
            defined: {
              name: 'evmTransactionParams',
            },
          },
        },
      ],
    },
  ],
  accounts: [
    {
      name: 'pendingErc20Deposit',
      discriminator: [214, 238, 68, 242, 98, 102, 251, 178],
    },
    {
      name: 'pendingErc20Withdrawal',
      discriminator: [33, 60, 7, 188, 11, 40, 41, 150],
    },
    {
      name: 'userErc20Balance',
      discriminator: [29, 16, 203, 40, 208, 43, 221, 11],
    },
  ],
  errors: [
    {
      code: 6000,
      name: 'invalidChainSignaturesProgram',
      msg: 'Invalid chain signatures program',
    },
    {
      code: 6001,
      name: 'serializationError',
      msg: 'Serialization error',
    },
    {
      code: 6002,
      name: 'functionNotFound',
      msg: 'Function not found in ABI',
    },
    {
      code: 6003,
      name: 'invalidRequestId',
      msg: 'Invalid request ID',
    },
    {
      code: 6004,
      name: 'invalidSignature',
      msg: 'Invalid signature',
    },
    {
      code: 6005,
      name: 'transferFailed',
      msg: 'Transfer failed',
    },
    {
      code: 6006,
      name: 'invalidOutput',
      msg: 'Invalid output format',
    },
    {
      code: 6007,
      name: 'overflow',
      msg: 'Arithmetic overflow',
    },
    {
      code: 6008,
      name: 'invalidAddress',
      msg: 'Invalid address',
    },
    {
      code: 6009,
      name: 'schemaTooLarge',
      msg: 'Schema size exceeds maximum allowed',
    },
    {
      code: 6010,
      name: 'insufficientBalance',
      msg: 'Insufficient balance',
    },
    {
      code: 6011,
      name: 'underflow',
      msg: 'Underflow error',
    },
  ],
  types: [
    {
      name: 'affinePoint',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'x',
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'y',
            type: {
              array: ['u8', 32],
            },
          },
        ],
      },
    },
    {
      name: 'evmTransactionParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'value',
            type: 'u128',
          },
          {
            name: 'gasLimit',
            type: 'u128',
          },
          {
            name: 'maxFeePerGas',
            type: 'u128',
          },
          {
            name: 'maxPriorityFeePerGas',
            type: 'u128',
          },
          {
            name: 'nonce',
            type: 'u64',
          },
          {
            name: 'chainId',
            type: 'u64',
          },
        ],
      },
    },
    {
      name: 'pendingErc20Deposit',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'requester',
            type: 'pubkey',
          },
          {
            name: 'amount',
            type: 'u128',
          },
          {
            name: 'erc20Address',
            type: {
              array: ['u8', 20],
            },
          },
          {
            name: 'path',
            type: 'string',
          },
          {
            name: 'requestId',
            type: {
              array: ['u8', 32],
            },
          },
        ],
      },
    },
    {
      name: 'pendingErc20Withdrawal',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'requester',
            type: 'pubkey',
          },
          {
            name: 'amount',
            type: 'u128',
          },
          {
            name: 'erc20Address',
            type: {
              array: ['u8', 20],
            },
          },
          {
            name: 'recipientAddress',
            type: {
              array: ['u8', 20],
            },
          },
          {
            name: 'path',
            type: 'string',
          },
          {
            name: 'requestId',
            type: {
              array: ['u8', 32],
            },
          },
        ],
      },
    },
    {
      name: 'signature',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'bigR',
            type: {
              defined: {
                name: 'affinePoint',
              },
            },
          },
          {
            name: 's',
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'recoveryId',
            type: 'u8',
          },
        ],
      },
    },
    {
      name: 'signingParams',
      docs: [
        'Parameters for requesting a signature from the chain signatures program',
      ],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'keyVersion',
            docs: ['Version of the key to use for signing'],
            type: 'u32',
          },
          {
            name: 'path',
            docs: ['Derivation path for the key (e.g., "ethereum,1")'],
            type: 'string',
          },
          {
            name: 'algo',
            docs: ['Signing algorithm (e.g., "secp256k1")'],
            type: 'string',
          },
          {
            name: 'dest',
            docs: ['Destination identifier'],
            type: 'string',
          },
          {
            name: 'params',
            docs: ['Additional parameters as JSON string'],
            type: 'string',
          },
        ],
      },
    },
    {
      name: 'userErc20Balance',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'amount',
            type: 'u128',
          },
        ],
      },
    },
    {
      name: 'vaultTransaction',
      docs: ['Represents a vault transaction to be processed'],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'toAddress',
            docs: ['EVM contract address to call'],
            type: {
              array: ['u8', 20],
            },
          },
          {
            name: 'value',
            docs: ['Amount of ETH to send with the transaction'],
            type: 'u128',
          },
          {
            name: 'gasLimit',
            docs: ['Gas limit for the transaction'],
            type: 'u128',
          },
          {
            name: 'maxFeePerGas',
            docs: ['Maximum fee per gas unit'],
            type: 'u128',
          },
          {
            name: 'maxPriorityFeePerGas',
            docs: ['Maximum priority fee per gas unit'],
            type: 'u128',
          },
          {
            name: 'nonce',
            docs: ['Transaction nonce'],
            type: 'u64',
          },
          {
            name: 'chainId',
            docs: ['Chain ID for the target EVM network'],
            type: 'u64',
          },
          {
            name: 'recipientAddress',
            docs: ['Recipient address for the vault operation'],
            type: {
              array: ['u8', 20],
            },
          },
          {
            name: 'amount',
            docs: ['Amount to deposit or withdraw'],
            type: 'u128',
          },
        ],
      },
    },
  ],
};
