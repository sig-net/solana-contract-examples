export const IDL = {
  address: '3wgi78Dc9kStc1bV4SmrHQXNerE3Z97yd1rQtDoDq5Xo',
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
          name: 'payer',
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
        {
          name: 'config',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 99, 111, 110, 102, 105, 103,
                ],
              },
            ],
          },
        },
        {
          name: 'transactionHistory',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  117, 115, 101, 114, 95, 116, 114, 97, 110, 115, 97, 99, 116,
                  105, 111, 110, 95, 104, 105, 115, 116, 111, 114, 121,
                ],
              },
              {
                kind: 'account',
                path: 'pending_deposit.requester',
                account: 'pendingErc20Deposit',
              },
            ],
          },
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
        {
          name: 'ethereumTxHash',
          type: {
            option: {
              array: ['u8', 32],
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
          name: 'payer',
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
        {
          name: 'config',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 99, 111, 110, 102, 105, 103,
                ],
              },
            ],
          },
        },
        {
          name: 'transactionHistory',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  117, 115, 101, 114, 95, 116, 114, 97, 110, 115, 97, 99, 116,
                  105, 111, 110, 95, 104, 105, 115, 116, 111, 114, 121,
                ],
              },
              {
                kind: 'account',
                path: 'pending_withdrawal.requester',
                account: 'pendingErc20Withdrawal',
              },
            ],
          },
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
        {
          name: 'ethereumTxHash',
          type: {
            option: {
              array: ['u8', 32],
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
          name: 'payer',
          writable: true,
          signer: true,
        },
        {
          name: 'requesterPda',
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
                kind: 'arg',
                path: 'requester',
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
          name: 'eventAuthority',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111,
                  114, 105, 116, 121,
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
        {
          name: 'config',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 99, 111, 110, 102, 105, 103,
                ],
              },
            ],
          },
        },
        {
          name: 'transactionHistory',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  117, 115, 101, 114, 95, 116, 114, 97, 110, 115, 97, 99, 116,
                  105, 111, 110, 95, 104, 105, 115, 116, 111, 114, 121,
                ],
              },
              {
                kind: 'arg',
                path: 'requester',
              },
            ],
          },
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
          name: 'requester',
          type: 'pubkey',
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
      name: 'initializeConfig',
      discriminator: [208, 127, 21, 1, 194, 190, 196, 70],
      accounts: [
        {
          name: 'payer',
          writable: true,
          signer: true,
        },
        {
          name: 'config',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 99, 111, 110, 102, 105, 103,
                ],
              },
            ],
          },
        },
        {
          name: 'systemProgram',
          address: '11111111111111111111111111111111',
        },
      ],
      args: [
        {
          name: 'mpcRootSignerAddress',
          type: {
            array: ['u8', 20],
          },
        },
      ],
    },
    {
      name: 'updateConfig',
      discriminator: [29, 158, 252, 191, 10, 83, 219, 99],
      accounts: [
        {
          name: 'config',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 99, 111, 110, 102, 105, 103,
                ],
              },
            ],
          },
        },
      ],
      args: [
        {
          name: 'mpcRootSignerAddress',
          type: {
            array: ['u8', 20],
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
          name: 'eventAuthority',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  95, 95, 101, 118, 101, 110, 116, 95, 97, 117, 116, 104, 111,
                  114, 105, 116, 121,
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
        {
          name: 'config',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  118, 97, 117, 108, 116, 95, 99, 111, 110, 102, 105, 103,
                ],
              },
            ],
          },
        },
        {
          name: 'transactionHistory',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [
                  117, 115, 101, 114, 95, 116, 114, 97, 110, 115, 97, 99, 116,
                  105, 111, 110, 95, 104, 105, 115, 116, 111, 114, 121,
                ],
              },
              {
                kind: 'account',
                path: 'authority',
              },
            ],
          },
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
    {
      name: 'userTransactionHistory',
      discriminator: [142, 226, 189, 154, 160, 189, 140, 159],
    },
    {
      name: 'vaultConfig',
      discriminator: [99, 86, 43, 216, 184, 102, 119, 77],
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
    {
      code: 6012,
      name: 'transactionNotFound',
      msg: 'Transaction not found in history',
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
      name: 'transactionRecord',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'requestId',
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'transactionType',
            type: {
              defined: {
                name: 'transactionType',
              },
            },
          },
          {
            name: 'status',
            type: {
              defined: {
                name: 'transactionStatus',
              },
            },
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
            name: 'timestamp',
            type: 'i64',
          },
          {
            name: 'ethereumTxHash',
            type: {
              option: {
                array: ['u8', 32],
              },
            },
          },
        ],
      },
    },
    {
      name: 'transactionStatus',
      type: {
        kind: 'enum',
        variants: [
          {
            name: 'pending',
          },
          {
            name: 'completed',
          },
          {
            name: 'failed',
          },
        ],
      },
    },
    {
      name: 'transactionType',
      type: {
        kind: 'enum',
        variants: [
          {
            name: 'deposit',
          },
          {
            name: 'withdrawal',
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
      name: 'userTransactionHistory',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'deposits',
            type: {
              vec: {
                defined: {
                  name: 'transactionRecord',
                },
              },
            },
          },
          {
            name: 'withdrawals',
            type: {
              vec: {
                defined: {
                  name: 'transactionRecord',
                },
              },
            },
          },
        ],
      },
    },
    {
      name: 'vaultConfig',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'mpcRootSignerAddress',
            type: {
              array: ['u8', 20],
            },
          },
        ],
      },
    },
  ],
};

export type SolDexIDL = {
  address: '3wgi78Dc9kStc1bV4SmrHQXNerE3Z97yd1rQtDoDq5Xo';
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
          name: 'payer';
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
        {
          name: 'config';
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
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'transactionHistory';
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
                  116,
                  114,
                  97,
                  110,
                  115,
                  97,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  104,
                  105,
                  115,
                  116,
                  111,
                  114,
                  121,
                ];
              },
              {
                kind: 'account';
                path: 'pending_deposit.requester';
                account: 'pendingErc20Deposit';
              },
            ];
          };
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
        {
          name: 'ethereumTxHash';
          type: {
            option: {
              array: ['u8', 32];
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
          name: 'payer';
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
        {
          name: 'config';
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
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'transactionHistory';
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
                  116,
                  114,
                  97,
                  110,
                  115,
                  97,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  104,
                  105,
                  115,
                  116,
                  111,
                  114,
                  121,
                ];
              },
              {
                kind: 'account';
                path: 'pending_withdrawal.requester';
                account: 'pendingErc20Withdrawal';
              },
            ];
          };
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
        {
          name: 'ethereumTxHash';
          type: {
            option: {
              array: ['u8', 32];
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
          name: 'payer';
          writable: true;
          signer: true;
        },
        {
          name: 'requesterPda';
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
                kind: 'arg';
                path: 'requester';
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
          name: 'eventAuthority';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
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
        {
          name: 'config';
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
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'transactionHistory';
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
                  116,
                  114,
                  97,
                  110,
                  115,
                  97,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  104,
                  105,
                  115,
                  116,
                  111,
                  114,
                  121,
                ];
              },
              {
                kind: 'arg';
                path: 'requester';
              },
            ];
          };
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
          name: 'requester';
          type: 'pubkey';
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
      name: 'initializeConfig';
      discriminator: [208, 127, 21, 1, 194, 190, 196, 70];
      accounts: [
        {
          name: 'payer';
          writable: true;
          signer: true;
        },
        {
          name: 'config';
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
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'systemProgram';
          address: '11111111111111111111111111111111';
        },
      ];
      args: [
        {
          name: 'mpcRootSignerAddress';
          type: {
            array: ['u8', 20];
          };
        },
      ];
    },
    {
      name: 'updateConfig';
      discriminator: [29, 158, 252, 191, 10, 83, 219, 99];
      accounts: [
        {
          name: 'config';
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
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: 'mpcRootSignerAddress';
          type: {
            array: ['u8', 20];
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
          name: 'eventAuthority';
          pda: {
            seeds: [
              {
                kind: 'const';
                value: [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
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
        {
          name: 'config';
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
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ];
              },
            ];
          };
        },
        {
          name: 'transactionHistory';
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
                  116,
                  114,
                  97,
                  110,
                  115,
                  97,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  104,
                  105,
                  115,
                  116,
                  111,
                  114,
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
    {
      name: 'userTransactionHistory';
      discriminator: [142, 226, 189, 154, 160, 189, 140, 159];
    },
    {
      name: 'vaultConfig';
      discriminator: [99, 86, 43, 216, 184, 102, 119, 77];
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
    {
      code: 6012;
      name: 'transactionNotFound';
      msg: 'Transaction not found in history';
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
      name: 'transactionRecord';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'requestId';
            type: {
              array: ['u8', 32];
            };
          },
          {
            name: 'transactionType';
            type: {
              defined: {
                name: 'transactionType';
              };
            };
          },
          {
            name: 'status';
            type: {
              defined: {
                name: 'transactionStatus';
              };
            };
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
            name: 'timestamp';
            type: 'i64';
          },
          {
            name: 'ethereumTxHash';
            type: {
              option: {
                array: ['u8', 32];
              };
            };
          },
        ];
      };
    },
    {
      name: 'transactionStatus';
      type: {
        kind: 'enum';
        variants: [
          {
            name: 'pending';
          },
          {
            name: 'completed';
          },
          {
            name: 'failed';
          },
        ];
      };
    },
    {
      name: 'transactionType';
      type: {
        kind: 'enum';
        variants: [
          {
            name: 'deposit';
          },
          {
            name: 'withdrawal';
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
      name: 'userTransactionHistory';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'deposits';
            type: {
              vec: {
                defined: {
                  name: 'transactionRecord';
                };
              };
            };
          },
          {
            name: 'withdrawals';
            type: {
              vec: {
                defined: {
                  name: 'transactionRecord';
                };
              };
            };
          },
        ];
      };
    },
    {
      name: 'vaultConfig';
      type: {
        kind: 'struct';
        fields: [
          {
            name: 'mpcRootSignerAddress';
            type: {
              array: ['u8', 20];
            };
          },
        ];
      };
    },
  ];
};
