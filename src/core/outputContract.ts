/**
 * 产出目录、台账与接入模板的单一事实来源。
 *
 * 规则与检查页示例引用同一份常量，避免文案与校验标准漂移。
 */

export const OUTPUT_VERSION_SUBDIRS: string[] = ["报告", "数据", "执行记录", "日志"];

export const OUTPUT_STATUSES: string[] = ["进行中", "成功", "部分完成", "失败"];

export const OUTPUT_ENV_VARS: string[] = [
  "SKILLFUSE_OUTPUT_DIR",
  "SKILLFUSE_BASELINE_DIR",
  "SKILLFUSE_OUTPUT_VERSION",
  "SKILLFUSE_PREVIOUS_DIR",
  "SKILLFUSE_NODE",
  "SKILLFUSE_TASK_DIR",
];

export const OUTPUT_DIR_TREE = `<产出根>/
└── <智能体>/
    └── 【课题】<课题名>/ 或 【临时】<课题名>/
        ├── 课题.json
        ├── 课题说明.md
        ├── 流程定义.json
        ├── 流转记录.jsonl
        ├── 总览.md
        ├── 未解决项.md
        ├── <分组目录>/…/<节点目录>/
        │   ├── 第N版/
        │   │   ├── 产出台账.json
        │   │   ├── 报告/
        │   │   ├── 数据/
        │   │   ├── 执行记录/
        │   │   └── 日志/
        │   └── 当前采用_第N版.md
        └── 交接与交付/
            └── 交接<N>_<交接名>_<MMDD>/
                ├── 清单.json
                ├── 交接说明.md
                └── 交付物/<节点目录名>/<主交付物文件名>`;

export const OUTPUT_LEDGER_SCHEMA = String.raw`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "版本台账",
  "type": "object",
  "required": [
    "schema_version",
    "引用",
    "节点",
    "版本",
    "课题",
    "中文目录名",
    "执行方",
    "外部团队",
    "skill",
    "创建时间",
    "完成时间",
    "执行状态",
    "触发",
    "输入",
    "基线",
    "评审结论",
    "未解决项",
    "artifacts",
    "metrics",
    "children",
    "会话"
  ],
  "properties": {
    "schema_version": {
      "const": "2.0"
    },
    "引用": {
      "type": "string",
      "pattern": "^[^/@#:\\s\\x00-\\x1f\\x7f]+@v[1-9][0-9]*(?:/[^/@#:\\s\\x00-\\x1f\\x7f]+@v[1-9][0-9]*)?$"
    },
    "节点": {
      "type": "string",
      "pattern": "^[^/@#:\\s\\x00-\\x1f\\x7f]+$"
    },
    "版本": {
      "type": "integer",
      "minimum": 1
    },
    "课题": {
      "type": "string",
      "minLength": 1
    },
    "中文目录名": {
      "type": "string",
      "minLength": 1
    },
    "执行方": {
      "enum": [
        "skill",
        "代码",
        "人工",
        "配置",
        "智能体",
        "报告整合"
      ]
    },
    "外部团队": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 1
        },
        {
          "type": "null"
        }
      ]
    },
    "skill": {
      "anyOf": [
        {
          "type": "object",
          "required": [
            "名称",
            "中文名",
            "skill版本",
            "来源sha256"
          ],
          "properties": {
            "名称": {
              "type": "string",
              "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
            },
            "中文名": {
              "type": "string",
              "minLength": 1
            },
            "skill版本": {
              "type": "string",
              "minLength": 1
            },
            "来源sha256": {
              "type": "string",
              "pattern": "^[a-fA-F0-9]{64}$"
            }
          },
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "创建时间": {
      "type": "string",
      "format": "date-time"
    },
    "完成时间": {
      "anyOf": [
        {
          "type": "string",
          "format": "date-time"
        },
        {
          "type": "null"
        }
      ]
    },
    "执行状态": {
      "enum": [
        "进行中",
        "成功",
        "部分完成",
        "失败"
      ]
    },
    "触发": {
      "type": "object",
      "required": [
        "类型",
        "编号"
      ],
      "properties": {
        "类型": {
          "enum": [
            "首次",
            "打回",
            "补证",
            "循环",
            "外部接收",
            "重跑"
          ]
        },
        "编号": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "additionalProperties": false
    },
    "输入": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "引用",
          "角色"
        ],
        "properties": {
          "引用": {
            "type": "string",
            "minLength": 1
          },
          "角色": {
            "enum": [
              "依赖",
              "基线",
              "参考"
            ]
          }
        },
        "additionalProperties": false
      }
    },
    "基线": {
      "anyOf": [
        {
          "type": "object",
          "required": [
            "引用",
            "策略"
          ],
          "properties": {
            "引用": {
              "type": "string",
              "minLength": 1
            },
            "策略": {
              "enum": [
                "上一版",
                "固定首版",
                "无"
              ]
            }
          },
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "评审结论": {
      "anyOf": [
        {
          "type": "object",
          "required": [
            "结论",
            "原文",
            "理由",
            "目标"
          ],
          "properties": {
            "结论": {
              "enum": [
                "通过",
                "带问题通过",
                "整改后复验",
                "补证后再判"
              ]
            },
            "原文": {
              "type": [
                "string",
                "null"
              ]
            },
            "理由": {
              "type": "string"
            },
            "目标": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[^/@#:\\s\\x00-\\x1f\\x7f]+$"
              }
            }
          },
          "additionalProperties": false
        },
        {
          "type": "null"
        }
      ]
    },
    "未解决项": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "描述",
          "指标",
          "标准",
          "差值"
        ],
        "properties": {
          "描述": {
            "type": "string",
            "minLength": 1
          },
          "指标": {
            "type": "string"
          },
          "标准": {
            "type": "string"
          },
          "差值": {
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    },
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "相对路径",
          "类型",
          "角色",
          "sha256",
          "字节数"
        ],
        "properties": {
          "相对路径": {
            "type": "string",
            "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\r\\n]+$"
          },
          "类型": {
            "enum": [
              "报告",
              "数据",
              "执行记录",
              "日志"
            ]
          },
          "角色": {
            "enum": [
              "主交付物",
              "附属"
            ]
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-fA-F0-9]{64}$"
          },
          "字节数": {
            "type": "integer",
            "minimum": 0
          }
        },
        "additionalProperties": false
      }
    },
    "metrics": {
      "type": "object"
    },
    "children": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      },
      "uniqueItems": true
    },
    "会话": {
      "type": "string",
      "minLength": 1
    },
    "执行记录": {
      "type": "object",
      "required": [
        "路径",
        "步骤数",
        "失败数"
      ],
      "properties": {
        "路径": {
          "type": "string",
          "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\r\\n]+$"
        },
        "步骤数": {
          "type": "integer",
          "minimum": 0
        },
        "失败数": {
          "type": "integer",
          "minimum": 0
        }
      },
      "additionalProperties": false
    },
    "轮次记录": {
      "type": "object",
      "additionalProperties": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "additionalProperties": false,
  "allOf": [
    {
      "if": {
        "properties": {
          "执行状态": {
            "enum": [
              "成功",
              "部分完成"
            ]
          }
        },
        "required": [
          "执行状态"
        ]
      },
      "then": {
        "properties": {
          "artifacts": {
            "contains": {
              "type": "object",
              "required": [
                "角色"
              ],
              "properties": {
                "角色": {
                  "const": "主交付物"
                }
              }
            },
            "minContains": 1,
            "maxContains": 1
          }
        }
      },
      "else": {
        "properties": {
          "artifacts": {
            "contains": {
              "type": "object",
              "required": [
                "角色"
              ],
              "properties": {
                "角色": {
                  "const": "主交付物"
                }
              }
            },
            "minContains": 0,
            "maxContains": 1
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "执行状态": {
            "enum": [
              "成功",
              "部分完成"
            ]
          },
          "执行方": {
            "enum": [
              "skill",
              "代码",
              "智能体"
            ]
          }
        },
        "required": [
          "执行状态",
          "执行方"
        ]
      },
      "then": {
        "required": [
          "执行记录"
        ]
      }
    },
    {
      "if": {
        "properties": {
          "外部团队": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "外部团队"
        ]
      },
      "then": {
        "properties": {
          "触发": {
            "properties": {
              "类型": {
                "const": "外部接收"
              }
            }
          }
        }
      }
    },
    {
      "if": {
        "properties": {
          "触发": {
            "properties": {
              "类型": {
                "enum": [
                  "打回",
                  "补证"
                ]
              }
            },
            "required": [
              "类型"
            ]
          }
        },
        "required": [
          "触发"
        ]
      },
      "then": {
        "properties": {
          "触发": {
            "properties": {
              "编号": {
                "type": "integer",
                "minimum": 1
              }
            }
          }
        }
      },
      "else": {
        "properties": {
          "触发": {
            "properties": {
              "编号": {
                "type": "null"
              }
            }
          }
        }
      }
    }
  ]
}
`;

export const OUTPUT_SECTION_MD = `## 产出契约

runner 即产出管家，在当前课题中按节点分配 v{n}，并通过 ${OUTPUT_ENV_VARS[2]} 提供版本号；重跑须分配新版本，不覆写旧版。runner 将本版目录设为 ${OUTPUT_ENV_VARS[0]}，通过 ${OUTPUT_ENV_VARS[4]} 提供节点、${OUTPUT_ENV_VARS[5]} 提供课题目录。所有文件均写入本版目录下的相对路径，并在产出台账.json 中登记。

目录按智能体 → 课题 → 分组 → 节点 → 第N版组织，无流程时智能体为「单独调用」。每个版本固定保留四区，即使为空也创建；课题内的「交接与交付」保存交接清单、说明和各节点主交付物副本，数据文件只在清单中引用：

\`\`\`text
${OUTPUT_DIR_TREE}
\`\`\`

本 skill 的唯一主交付物：报告/<主交付文件名>（请替换为实际文件名和类型）。成功或部分完成时恰好一件主交付物；其他文件在台账的 artifacts 中标为附属。台账记录节点、版本、执行状态、触发、输入、基线与产物。执行状态使用 ${OUTPUT_STATUSES.join("、")}。新版通过 ${OUTPUT_ENV_VARS[3]} 定位上一版目录，在交付说明中回指上一版；首次无上一版时明确说明。

迭代、优化或对比时，从 ${OUTPUT_ENV_VARS[1]} 读取产出管家指定的基线，记录所用引用、文件及比较口径。基线按节点策略或显式指定选择，可能为上一版、固定首版或跨课题版本，不以 ${OUTPUT_ENV_VARS[3]} 替代基线目录；无基线时说明原因并跳过版本对比。`;
