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
];

export const OUTPUT_DIR_TREE = `【课题】<课题名>/
└── 第N次执行_MMDD上午|下午|晚上/
    └── 各环节产出/
        └── <skill中文名>/
            └── 第N版/
                ├── 产出台账.json
                ├── 报告/
                ├── 数据/
                ├── 执行记录/
                └── 日志/`;

export const OUTPUT_LEDGER_SCHEMA = String.raw`{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "产出台账",
  "description": "产出管家的版本、执行和课题台账。目录供人阅读，标准ID供机器关联。",
  "type": "object",
  "required": [
    "schema_version",
    "kind",
    "标准ID",
    "中文目录名",
    "课题ID",
    "创建时间",
    "状态",
    "inputs",
    "artifacts",
    "metrics",
    "children"
  ],
  "properties": {
    "schema_version": {
      "const": "1.0"
    },
    "kind": {
      "enum": [
        "版本",
        "执行",
        "课题"
      ]
    },
    "标准ID": {
      "$ref": "#/$defs/id"
    },
    "中文目录名": {
      "type": "string",
      "minLength": 1,
      "description": "从产出根目录起算的实际落盘相对路径。"
    },
    "课题ID": {
      "$ref": "#/$defs/id"
    },
    "执行ID": {
      "$ref": "#/$defs/id"
    },
    "版本号": {
      "type": "integer",
      "minimum": 1
    },
    "上一版版本号": {
      "type": [
        "integer",
        "null"
      ],
      "minimum": 1
    },
    "skill": {
      "type": "object",
      "required": [
        "名称",
        "中文名",
        "skill版本",
        "来源sha256"
      ],
      "properties": {
        "名称": {
          "$ref": "#/$defs/slug"
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
          "$ref": "#/$defs/sha256"
        }
      },
      "additionalProperties": false
    },
    "创建时间": {
      "type": "string",
      "format": "date-time"
    },
    "状态": {
      "enum": [
        "进行中",
        "成功",
        "部分完成",
        "失败"
      ],
      "description": "进行中=已开目录尚未收尾；成功/部分完成=终态；失败=保留现场。"
    },
    "inputs": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "类型",
          "引用",
          "角色"
        ],
        "properties": {
          "类型": {
            "enum": [
              "产物",
              "用户",
              "外部"
            ]
          },
          "引用": {
            "type": "string",
            "minLength": 1,
            "description": "产物用标准ID；用户或外部输入用可追溯引用。"
          },
          "角色": {
            "enum": [
              "上游",
              "基线",
              "参考"
            ]
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
            "$ref": "#/$defs/relativePath"
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
            "$ref": "#/$defs/sha256"
          },
          "字节数": {
            "type": "integer",
            "minimum": 0
          }
        },
        "additionalProperties": false
      }
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
          "$ref": "#/$defs/relativePath",
          "description": "指向沿用 trace 契约的 JSONL 文件。"
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
    "metrics": {
      "type": "object",
      "description": "规范得分、耗时等指标；值和口径由产出方提供。"
    },
    "children": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/id"
      },
      "uniqueItems": true
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "顺序",
          "skill名称",
          "最终采用版本ID"
        ],
        "properties": {
          "顺序": {
            "type": "integer",
            "minimum": 1
          },
          "skill名称": {
            "$ref": "#/$defs/slug"
          },
          "最终采用版本ID": {
            "$ref": "#/$defs/id"
          }
        },
        "additionalProperties": false
      }
    },
    "目标": {
      "type": "string",
      "minLength": 1
    },
    "验收标准": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "累计执行列表": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/id"
      },
      "uniqueItems": true
    }
  },
  "oneOf": [
    {
      "properties": {
        "kind": {
          "const": "版本"
        }
      },
      "required": [
        "执行ID",
        "版本号",
        "上一版版本号",
        "skill"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "steps"
            ]
          },
          {
            "required": [
              "目标"
            ]
          },
          {
            "required": [
              "验收标准"
            ]
          },
          {
            "required": [
              "累计执行列表"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "kind": {
          "const": "执行"
        }
      },
      "required": [
        "执行ID",
        "steps"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "版本号"
            ]
          },
          {
            "required": [
              "上一版版本号"
            ]
          },
          {
            "required": [
              "skill"
            ]
          },
          {
            "required": [
              "目标"
            ]
          },
          {
            "required": [
              "验收标准"
            ]
          },
          {
            "required": [
              "累计执行列表"
            ]
          }
        ]
      }
    },
    {
      "properties": {
        "kind": {
          "const": "课题"
        }
      },
      "required": [
        "目标",
        "验收标准",
        "累计执行列表"
      ],
      "not": {
        "anyOf": [
          {
            "required": [
              "执行ID"
            ]
          },
          {
            "required": [
              "版本号"
            ]
          },
          {
            "required": [
              "上一版版本号"
            ]
          },
          {
            "required": [
              "skill"
            ]
          },
          {
            "required": [
              "执行记录"
            ]
          },
          {
            "required": [
              "steps"
            ]
          }
        ]
      }
    }
  ],
  "additionalProperties": false,
  "$defs": {
    "slug": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    },
    "id": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$"
    },
    "sha256": {
      "type": "string",
      "pattern": "^[a-fA-F0-9]{64}$"
    },
    "relativePath": {
      "type": "string",
      "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\r\\n]+$"
    }
  },
  "allOf": [
    {
      "$comment": "完成态：必须有产物且恰好一个主交付物。",
      "if": {
        "properties": {
          "状态": {
            "enum": [
              "成功",
              "部分完成"
            ]
          }
        },
        "required": [
          "状态"
        ]
      },
      "then": {
        "properties": {
          "artifacts": {
            "minItems": 1,
            "contains": {
              "type": "object",
              "properties": {
                "角色": {
                  "const": "主交付物"
                }
              },
              "required": [
                "角色"
              ]
            },
            "minContains": 1,
            "maxContains": 1
          }
        }
      }
    },
    {
      "$comment": "进行中或失败：允许没有产物；若有主交付物也至多一个。保住现场优先于满足格式。",
      "if": {
        "properties": {
          "状态": {
            "enum": [
              "进行中",
              "失败"
            ]
          }
        },
        "required": [
          "状态"
        ]
      },
      "then": {
        "properties": {
          "artifacts": {
            "minItems": 0,
            "contains": {
              "type": "object",
              "properties": {
                "角色": {
                  "const": "主交付物"
                }
              },
              "required": [
                "角色"
              ]
            },
            "minContains": 0,
            "maxContains": 1
          }
        }
      }
    },
    {
      "$comment": "版本级与执行级在完成态必须留下执行记录。",
      "if": {
        "properties": {
          "kind": {
            "enum": [
              "版本",
              "执行"
            ]
          },
          "状态": {
            "enum": [
              "成功",
              "部分完成"
            ]
          }
        },
        "required": [
          "kind",
          "状态"
        ]
      },
      "then": {
        "required": [
          "执行记录"
        ]
      }
    },
    {
      "$comment": "执行台账在完成态必须记录至少一个编排步骤；run-begin 时允许为空。",
      "if": {
        "properties": {
          "kind": {
            "const": "执行"
          },
          "状态": {
            "enum": [
              "成功",
              "部分完成"
            ]
          }
        },
        "required": [
          "kind",
          "状态"
        ]
      },
      "then": {
        "properties": {
          "steps": {
            "minItems": 1
          }
        }
      }
    }
  ]
}
`;

export const OUTPUT_SECTION_MD = `## 产出契约

由 runner 为本 skill 在当前课题中分配 v{n}，并通过 ${OUTPUT_ENV_VARS[2]} 提供版本号；重跑须分配新版本，不覆写旧版。runner 将本版目录设为 ${OUTPUT_ENV_VARS[0]}。所有文件均写入该目录下的相对路径，并在产出台账.json 中登记。

目录按课题、执行、版本三层组织。每个版本固定保留四区，即使为空也创建：

\`\`\`text
${OUTPUT_DIR_TREE}
\`\`\`

本 skill 的主交付物：报告/<主交付文件名>（请替换为实际文件名和类型）。成功或部分完成时恰好一件主交付物；其他文件在台账的 artifacts 中标为附属。台账记录状态、输入、产物及上一版版本号，新版须回指上一版。状态使用 ${OUTPUT_STATUSES.join("、")}。

迭代、优化或对比时，从 ${OUTPUT_ENV_VARS[1]} 读取上一版产出作为基线，记录所用文件及比较口径；首次无基线时说明原因并跳过版本对比。`;
