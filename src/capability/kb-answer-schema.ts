// Pinned copy of kb-answer-v1 (KB repo: kb-mcp/internal/answer/schema.json). audee doctor fails when they differ;
// update both together.
export const KB_ANSWER_SCHEMA: Record<string, unknown> = {
  "$id": "kb-answer-v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "status",
    "mode",
    "lang",
    "topic",
    "answer",
    "product",
    "sources",
    "notes",
    "missing"
  ],
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "done",
        "failed"
      ]
    },
    "mode": {
      "type": "string",
      "enum": [
        "product",
        "tech"
      ],
      "description": "The mode the prompt states for this answer."
    },
    "lang": {
      "type": "string",
      "enum": [
        "vi",
        "en"
      ],
      "description": "Language of the question; every text field is written in it."
    },
    "topic": {
      "type": "string",
      "description": "What the question asks, at most 12 words / 120 characters, no links or names of people."
    },
    "answer": {
      "type": "string",
      "description": "Tech mode only: the Markdown answer, at most 30000 characters. Product mode: empty string."
    },
    "product": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "title",
        "readings",
        "follow_ups"
      ],
      "properties": {
        "title": {
          "type": "string",
          "description": "Plain-language headline, at most 120 characters. Empty in tech mode."
        },
        "readings": {
          "type": "array",
          "description": "Product mode: 1 to 4 readings of the question (one unless it is ambiguous). Tech mode: empty.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "heading",
              "summary",
              "purpose",
              "journey",
              "rules",
              "config",
              "diagrams"
            ],
            "properties": {
              "heading": {
                "type": "string",
                "description": "Name of this reading, at most 120 characters; shown only with 2+ readings."
              },
              "summary": {
                "type": "string",
                "description": "2 to 4 sentences: what it does and for whom, at most 800 characters."
              },
              "purpose": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "recorded",
                  "text",
                  "source"
                ],
                "properties": {
                  "recorded": {
                    "type": "boolean",
                    "description": "True only when a sentence in a wiki doc under product/, specs/, roadmap/ or explanatory/ states why."
                  },
                  "text": {
                    "type": "string",
                    "description": "That reason, paraphrased, at most 600 characters. Empty when not recorded."
                  },
                  "source": {
                    "type": "string",
                    "description": "Wiki-relative path of that doc, e.g. explanatory/flows/x.md, at most 200 characters. Empty when not recorded."
                  }
                }
              },
              "journey": {
                "type": "array",
                "description": "Ordered steps as players and operators experience them, at most 10.",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "actor",
                    "text",
                    "evidence",
                    "cite"
                  ],
                  "properties": {
                    "actor": {
                      "type": "string",
                      "enum": [
                        "player",
                        "operator",
                        "system"
                      ]
                    },
                    "text": {
                      "type": "string",
                      "description": "At most 400 characters."
                    },
                    "evidence": {
                      "type": "string",
                      "enum": [
                        "src",
                        "kb",
                        "unverified"
                      ]
                    },
                    "cite": {
                      "type": "string",
                      "description": "Repo-relative path:line for src, doc path for kb, empty for unverified. Never shown."
                    }
                  }
                }
              },
              "rules": {
                "type": "array",
                "description": "Defaults, limits, failure behaviour and exclusions, at most 12.",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "kind",
                    "text",
                    "evidence",
                    "cite"
                  ],
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "default",
                        "limit",
                        "failure",
                        "exclusion",
                        "other"
                      ]
                    },
                    "text": {
                      "type": "string",
                      "description": "At most 400 characters."
                    },
                    "evidence": {
                      "type": "string",
                      "enum": [
                        "src",
                        "kb",
                        "unverified"
                      ]
                    },
                    "cite": {
                      "type": "string",
                      "description": "Repo-relative path:line for src, doc path for kb, empty for unverified. Never shown."
                    }
                  }
                }
              },
              "config": {
                "type": "array",
                "description": "Settings someone can change, at most 12.",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "setting",
                    "where",
                    "default"
                  ],
                  "properties": {
                    "setting": {
                      "type": "string",
                      "description": "At most 120 characters."
                    },
                    "where": {
                      "type": "string",
                      "enum": [
                        "portal",
                        "engineering",
                        "unknown"
                      ]
                    },
                    "default": {
                      "type": "string",
                      "description": "Default value in plain words, at most 120 characters; empty when unknown."
                    }
                  }
                }
              },
              "diagrams": {
                "type": "array",
                "description": "At most 2. steps: a journey of 3+ steps, nodes in order, each joined to the next; edges only label consecutive nodes. decision: the first node is one check joined to each of the other 2-4 outcome nodes; edges only label those joins.",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "kind",
                    "caption",
                    "nodes",
                    "edges"
                  ],
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "steps",
                        "decision"
                      ]
                    },
                    "caption": {
                      "type": "string",
                      "description": "At most 160 characters."
                    },
                    "nodes": {
                      "type": "array",
                      "description": "At most 8.",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "id",
                          "label"
                        ],
                        "properties": {
                          "id": {
                            "type": "string",
                            "description": "Short unique id, at most 20 characters."
                          },
                          "label": {
                            "type": "string",
                            "description": "At most 60 characters."
                          }
                        }
                      }
                    },
                    "edges": {
                      "type": "array",
                      "description": "At most 10.",
                      "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": [
                          "from",
                          "to",
                          "label"
                        ],
                        "properties": {
                          "from": {
                            "type": "string"
                          },
                          "to": {
                            "type": "string"
                          },
                          "label": {
                            "type": "string",
                            "description": "At most 40 characters; may be empty."
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "follow_ups": {
          "type": "array",
          "description": "Only for a question too broad to answer: 3 to 5 narrower questions, each at most 200 characters. Otherwise empty.",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "sources": {
      "type": "array",
      "description": "Repo-relative paths cited, at most 10.",
      "items": {
        "type": "string"
      }
    },
    "notes": {
      "type": "array",
      "description": "At most 5, each under 250 characters.",
      "items": {
        "type": "string"
      }
    },
    "missing": {
      "type": "array",
      "description": "Always empty.",
      "items": {
        "type": "string"
      }
    }
  }
};
