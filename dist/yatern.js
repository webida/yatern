(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.YAtern = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var util = require('util');

function getNodeList(ast, startNum) {
    var nodeList = [];

    var num = startNum === undefined ? 0 : startNum;

    function assignId(node) {
        node['@label'] = num;
        nodeList.push(node);
        num++;
    }

    // Label every AST node with property 'type'
    function labelNodeWithType(node) {
        if (node && node.hasOwnProperty('type')) {
            assignId(node);
        }
        if (node && typeof node === 'object') {
            for (var p in node) {
                labelNodeWithType(node[p]);
            }
        }
    }

    labelNodeWithType(ast);

    return nodeList;
}

function showUnfolded(obj) {
    console.log(util.inspect(obj, { depth: null }));
}

exports.getNodeList = getNodeList;
exports.showUnfolded = showUnfolded;

},{"util":20}],2:[function(require,module,exports){
'use strict';

var types = require('../domains/types');
var walk = require('acorn/dist/walk');
var status = require('../domains/status');
var cstr = require('./constraints');

// arguments are " oldStatus (, name, val)* "
function changedStatus(oldStatus) {
    var newStatus = new status.Status();
    for (var i = 1; i < arguments.length; i = i + 2) {
        newStatus[arguments[i]] = arguments[i + 1];
    }for (var p in oldStatus) {
        if (newStatus[p] === undefined) newStatus[p] = oldStatus[p];
    }
    return newStatus;
}

// returns [access type, prop value]
function propAccess(node) {
    var prop = node.property;
    if (!node.computed) {
        return ['dotAccess', prop.name];
    }
    if (prop.type === 'Literal') {
        if (typeof prop.value === 'string') return ['stringLiteral', prop.value];
        if (typeof prop.value === 'number')
            // convert number to string
            return ['numberLiteral', prop.value + ''];
    }
    return ["computed", null];
}

function unopResultType(op) {
    switch (op) {
        case '+':case '-':case '~':
            return types.PrimNumber;
        case '!':
            return types.PrimBoolean;
        case 'typeof':
            return types.PrimString;
        case 'void':case 'delete':
            return null;
    }
}

function binopIsBoolean(op) {
    switch (op) {
        case '==':case '!=':case '===':case '!==':
        case '<':case '>':case '>=':case '<=':
        case 'in':case 'instanceof':
            return true;
    }
    return false;
}

// To prevent recursion,
// we remember the status used in addConstraints
var visitedStatus = [];
var constraints = [];
function clearConstraints() {
    visitedStatus.length = 0;
    constraints.length = 0;
}

var rtCX = undefined;
function addConstraints(ast, initStatus, newRtCX) {

    // set rtCX
    rtCX = newRtCX || rtCX;
    var Ĉ = rtCX.Ĉ;

    // Check whether we have processed 'initStatus' before
    for (var i = 0; i < visitedStatus.length; i++) {
        if (initStatus.equals(visitedStatus[i])) {
            // If so, do nothing
            // signifying we didn't add constraints
            return false;
        }
    }
    // If the initStatus is new, push it.
    // We do not record ast since ast node depends on the status
    visitedStatus.push(initStatus);

    function readMember(node, curStatus, c) {
        var ret = Ĉ.get(node, curStatus.delta);
        var objAVal = c(node.object, curStatus, undefined);
        if (node.property.type !== 'Identifier') {
            // return from property is ignored
            c(node.property, curStatus, undefined);
        }

        var _propAccess = propAccess(node);

        var propName = _propAccess[1];

        constraints.push({ OBJ: objAVal,
            PROP: propName,
            READ_TO: ret });
        objAVal.propagate(new cstr.ReadProp(propName, ret));

        // returns AVal for receiver and read member
        return [objAVal, ret];
    }

    // constraint generating walker for expressions
    var constraintGenerator = walk.make({

        Identifier: function Identifier(node, curStatus, c) {
            var av = curStatus.sc.getAValOf(node.name);
            // use aval in the scope
            Ĉ.set(node, curStatus.delta, av);
            return av;
        },

        ThisExpression: function ThisExpression(node, curStatus, c) {
            var av = curStatus.self;
            // use aval for 'this'
            Ĉ.set(node, curStatus.delta, av);
            return av;
        },

        Literal: function Literal(node, curStatus, c) {
            var res = Ĉ.get(node, curStatus.delta);
            if (node.regex) {
                // not implemented yet
                // throw new Error('regex literal is not implemented yet');
                return res;
            }
            switch (typeof node.value) {
                case 'number':
                    constraints.push({ TYPE: types.PrimNumber,
                        INCL_SET: res });
                    res.addType(types.PrimNumber);
                    break;
                case 'string':
                    constraints.push({ TYPE: types.PrimString,
                        INCL_SET: res });
                    res.addType(types.PrimString);
                    break;
                case 'boolean':
                    constraints.push({ TYPE: types.PrimBoolean,
                        INCL_SET: res });
                    res.addType(types.PrimBoolean);
                    break;
                case 'object':
                    // I guess: Literal && object ==> node.value == null
                    // null is ignored, so nothing to add
                    break;
                case 'function':
                    throw new Error('I guess function is impossible here.');
            }
            return res;
        },

        AssignmentExpression: function AssignmentExpression(node, curStatus, c) {
            var rhsAVal = c(node.right, curStatus, undefined);
            if (node.left.type === 'Identifier') {
                // LHS is a simple variable.
                var varName = node.left.name;
                var lhsAVal = curStatus.sc.getAValOf(varName);
                // lhs is not visited. Need to handle here.
                // Use aval found in the scope for lhs
                Ĉ.set(node.left, curStatus.delta, lhsAVal);

                if (node.operator === '=') {
                    // simple assignment
                    constraints.push({
                        FROM: rhsAVal,
                        TO: lhsAVal
                    });
                    rhsAVal.propagate(lhsAVal);
                    // node's AVal from RHS
                    Ĉ.set(node, curStatus.delta, rhsAVal);
                    return rhsAVal;
                }
                // updating assignment
                var resAVal = Ĉ.get(node, curStatus.delta);
                if (node.operator === '+=') {
                    // concatenating update
                    constraints.push({
                        ADD_OPRD1: lhsAVal,
                        ADD_OPRD2: rhsAVal,
                        RESULT: resAVal
                    });
                    lhsAVal.propagate(new cstr.IsAdded(rhsAVal, resAVal));
                    rhsAVal.propagate(new cstr.IsAdded(lhsAVal, resAVal));
                } else {
                    // arithmetic update
                    constraints.push({
                        TYPE: types.PrimNumber,
                        INCL_SET: resAVal
                    });
                    resAVal.addType(types.PrimNumber);
                }
                return resAVal;
            } else if (node.left.type === 'MemberExpression') {
                var objAVal = c(node.left.object, curStatus, undefined);

                var _propAccess2 = propAccess(node.left);

                var accType = _propAccess2[0];
                var propName = _propAccess2[1];

                if (node.operator === '=') {
                    // assignment to member
                    constraints.push({
                        OBJ: objAVal,
                        PROP: propName,
                        WRITE_WITH: rhsAVal
                    });
                    objAVal.propagate(new cstr.WriteProp(propName, rhsAVal));
                    // if property is number literal, also write to 'unknown'
                    if (accType === 'numberLiteral') {
                        objAVal.propagate(new cstr.WriteProp(null, rhsAVal));
                    }
                    // node's AVal from RHS
                    Ĉ.set(node, curStatus.delta, rhsAVal);
                    return rhsAVal;
                }
                // updating assignment
                var resAVal = Ĉ.get(node, curStatus.delta);

                var _readMember = readMember(node.left, curStatus, c);

                var retAVal = _readMember[1];

                if (node.operator === '+=') {
                    // concatenating update
                    constraints.push({
                        ADD_OPRD1: retAVal,
                        ADD_OPRD2: rhsAVal,
                        RESULT: resAVal
                    });
                    retAVal.propagate(new cstr.IsAdded(rhsAVal, resAVal));
                    rhsAVal.propagate(new cstr.IsAdded(retAVal, resAVal));
                } else {
                    // arithmetic update
                    constraints.push({
                        TYPE: types.PrimNumber,
                        INCL_SET: resAVal
                    });
                    resAVal.addType(types.PrimNumber);
                }
                return resAVal;
            } else {
                console.info('Assignment using pattern is not implemented');
            }
        },

        VariableDeclaration: function VariableDeclaration(node, curStatus, c) {
            for (var i = 0; i < node.declarations.length; i++) {
                var decl = node.declarations[i];
                var lhsAVal = curStatus.sc.getAValOf(decl.id.name);
                // declared var node is 'id'
                Ĉ.set(decl.id, curStatus.delta, lhsAVal);
                if (decl.init) {
                    var rhsAVal = c(decl.init, curStatus, undefined);
                    Ĉ.set(decl.init, curStatus.delta, rhsAVal);
                    constraints.push({ FROM: rhsAVal,
                        TO: lhsAVal });
                    rhsAVal.propagate(lhsAVal);
                }
            }
        },

        LogicalExpression: function LogicalExpression(node, curStatus, c) {
            var res = Ĉ.get(node, curStatus.delta);
            var left = c(node.left, curStatus, undefined);
            var right = c(node.right, curStatus, undefined);
            constraints.push({ FROM: left, TO: res }, { FROM: right, TO: res });
            left.propagate(res);
            right.propagate(res);
            return res;
        },

        ConditionalExpression: function ConditionalExpression(node, curStatus, c) {
            var res = Ĉ.get(node, curStatus.delta);
            c(node.test, curStatus, undefined);
            var cons = c(node.consequent, curStatus, undefined);
            var alt = c(node.alternate, curStatus, undefined);
            constraints.push({ FROM: cons, TO: res }, { FROM: alt, TO: res });
            cons.propagate(res);
            alt.propagate(res);
            return res;
        },

        NewExpression: function NewExpression(node, curStatus, c) {
            var ret = Ĉ.get(node, curStatus.delta);
            var callee = c(node.callee, curStatus, undefined);
            var args = [];
            for (var i = 0; i < node.arguments.length; i++) {
                args.push(c(node.arguments[i], curStatus, undefined));
            }
            var newDelta = curStatus.delta.appendOne(node['@label']);
            constraints.push({ CONSTRUCTOR: callee,
                ARGS: args,
                RET: ret,
                EXC: curStatus.exc,
                DELTA: newDelta });
            callee.propagate(new cstr.IsCtor(args, ret, curStatus.exc, newDelta));
            return ret;
        },

        ArrayExpression: function ArrayExpression(node, curStatus, c) {
            var ret = Ĉ.get(node, curStatus.delta);
            // NOTE prototype object is not recorded in Ĉ
            var arrType = new types.ArrType(new types.AVal(rtCX.protos.Array));
            // add length property
            arrType.getProp('length').addType(types.PrimNumber);

            constraints.push({ TYPE: arrType, INCL_SET: ret });
            ret.addType(arrType);

            // add array elements
            for (var i = 0; i < node.elements.length; i++) {
                var eltAVal = c(node.elements[i], curStatus, undefined);

                var prop = i + '';
                constraints.push({ OBJ: ret, PROP: prop, AVAL: eltAVal });
                constraints.push({ OBJ: ret, PROP: null, AVAL: eltAVal });
                ret.propagate(new cstr.WriteProp(prop, eltAVal));
                ret.propagate(new cstr.WriteProp(null, eltAVal));
            }
            return ret;
        },

        ObjectExpression: function ObjectExpression(node, curStatus, c) {
            var ret = Ĉ.get(node, curStatus.delta);
            // NOTE prototype object is not recorded in Ĉ
            var objType = new types.ObjType(new types.AVal(rtCX.protos.Object));
            constraints.push({ TYPE: objType, INCL_SET: ret });
            ret.addType(objType);

            for (var i = 0; i < node.properties.length; i++) {
                var propPair = node.properties[i];
                var propKey = propPair.key;
                var _name = undefined;
                var propExpr = propPair.value;

                var fldAVal = c(propExpr, curStatus, undefined);

                if (propKey.type === 'Identifier') {
                    _name = propKey.name;
                } else if (typeof propKey.value === 'string') {
                    _name = propKey.value;
                } else if (typeof propKey.value === 'number') {
                    // convert number to string
                    _name = propKey.value + '';
                }
                constraints.push({ OBJ: ret, PROP: _name, AVAL: fldAVal });
                ret.propagate(new cstr.WriteProp(_name, fldAVal));
            }
            return ret;
        },

        FunctionExpression: function FunctionExpression(node, curStatus, c) {
            if (!node.fnInstances) {
                node.fnInstances = [];
            }
            var fnInstance = null;
            node.fnInstances.forEach(function (fnType) {
                if (fnType.sc === curStatus.sc) {
                    fnInstance = fnType;
                }
            });
            if (!fnInstance) {
                // NOTE prototype object is not recorded in Ĉ
                fnInstance = new types.FnType(new types.AVal(rtCX.protos.Function), '[anonymous function]', node.body['@block'].getParamVarNames(), curStatus.sc, node, rtCX.protos.Object);
                node.fnInstances.push(fnInstance);
                // NOTE prototype object is not recorded in Ĉ
                var prototypeObject = new types.ObjType(new types.AVal(rtCX.protos.Object), '?.prototype');
                // For .prototype
                var prototypeProp = fnInstance.getProp('prototype');
                constraints.push({ TYPE: prototypeObject,
                    INCL_SET: prototypeProp });
                prototypeProp.addType(prototypeObject);
                // For .prototype.constructor
                var constructorProp = prototypeObject.getProp('constructor');
                constraints.push({ TYPE: fnInstance,
                    INCL_SET: constructorProp });
                constructorProp.addType(fnInstance);
            }
            var ret = Ĉ.get(node, curStatus.delta);
            constraints.push({ TYPE: fnInstance,
                INCL_SET: ret });
            ret.addType(fnInstance);
            return ret;
        },

        FunctionDeclaration: function FunctionDeclaration(node, curStatus, c) {
            // Drop initial catch scopes
            var sc0 = curStatus.sc.removeInitialCatchBlocks();
            if (!node.fnInstances) {
                node.fnInstances = [];
            }
            var fnInstance = null;
            node.fnInstances.forEach(function (fnType) {
                if (fnType.sc === sc0) {
                    fnInstance = fnType;
                }
            });
            if (!fnInstance) {
                // NOTE prototype object is not recorded in Ĉ
                fnInstance = new types.FnType(new types.AVal(rtCX.protos.Function), node.id.name, node.body['@block'].getParamVarNames(), sc0, node, rtCX.protos.Object);
                node.fnInstances.push(fnInstance);
                // for each fnInstance, assign one prototype object
                // NOTE prototype object is not recorded in Ĉ
                var prototypeObject = new types.ObjType(new types.AVal(rtCX.protos.Object), node.id.name + '.prototype');
                // For .prototype
                var prototypeProp = fnInstance.getProp('prototype');
                constraints.push({ TYPE: prototypeObject,
                    INCL_SET: prototypeProp });
                prototypeProp.addType(prototypeObject);
                // For .prototype.constructor
                var constructorProp = prototypeObject.getProp('constructor');
                constraints.push({ TYPE: fnInstance,
                    INCL_SET: constructorProp });
                constructorProp.addType(fnInstance);
            }
            var lhsAVal = sc0.getAValOf(node.id.name);
            constraints.push({ TYPE: fnInstance,
                INCL_SET: lhsAVal });
            lhsAVal.addType(fnInstance);
            // nothing to return
            return types.AValNull;
        },

        SequenceExpression: function SequenceExpression(node, curStatus, c) {
            var lastIndex = node.expressions.length - 1;
            for (var i = 0; i < lastIndex; i++) {
                c(node.expressions[i], curStatus, undefined);
            }
            var lastAVal = c(node.expressions[lastIndex], curStatus, undefined);
            Ĉ.set(node, curStatus.delta, lastAVal);
            return lastAVal;
        },

        UnaryExpression: function UnaryExpression(node, curStatus, c) {
            c(node.argument, curStatus, undefined);
            var res = Ĉ.get(node, curStatus.delta);
            var type = unopResultType(node.operator);
            if (type) {
                constraints.push({ TYPE: type,
                    INCL_SET: res });
                res.addType(type);
            }
            return res;
        },

        UpdateExpression: function UpdateExpression(node, curStatus, c) {
            c(node.argument, curStatus, undefined);
            var res = Ĉ.get(node, curStatus.delta);
            constraints.push({ TYPE: types.PrimNumber,
                INCL_SET: res });
            res.addType(types.PrimNumber);
            // We ignore the effect of updating to number type
            return res;
        },

        BinaryExpression: function BinaryExpression(node, curStatus, c) {
            var lOprd = c(node.left, curStatus, undefined);
            var rOprd = c(node.right, curStatus, undefined);
            var res = Ĉ.get(node, curStatus.delta);

            if (node.operator == '+') {
                constraints.push({ ADD_OPRD1: lOprd,
                    ADD_OPRD2: rOprd,
                    RESULT: res });
                lOprd.propagate(new cstr.IsAdded(rOprd, res));
                rOprd.propagate(new cstr.IsAdded(lOprd, res));
            } else {
                if (binopIsBoolean(node.operator)) {
                    constraints.push({ TYPE: types.PrimBoolean,
                        INCL_SET: res });
                    res.addType(types.PrimBoolean);
                } else {
                    constraints.push({ TYPE: types.PrimNumber,
                        INCL_SET: res });
                    res.addType(types.PrimNumber);
                }
            }
            return res;
        },

        TryStatement: function TryStatement(node, curStatus, c) {
            // construct scope chain for catch block
            var catchBlockSC = node.handler.body['@block'].getScopeInstance(curStatus.sc, curStatus.delta);
            // get the AVal for exception parameter
            var excAVal = catchBlockSC.getAValOf(node.handler.param.name);

            // for try block
            var tryStatus = changedStatus(curStatus, 'exc', excAVal);
            c(node.block, tryStatus, undefined);

            // for catch block
            var catchStatus = changedStatus(curStatus, 'sc', catchBlockSC);
            c(node.handler.body, catchStatus, undefined);

            // for finally block
            if (node.finalizer !== null) c(node.finalizer, curStatus, undefined);
        },

        ThrowStatement: function ThrowStatement(node, curStatus, c) {
            var thr = c(node.argument, curStatus, undefined);
            constraints.push({ FROM: thr,
                TO: curStatus.exc });
            thr.propagate(curStatus.exc);
        },

        CallExpression: function CallExpression(node, curStatus, c) {
            var resAVal = Ĉ.get(node, curStatus.delta);
            var argAVals = [];

            // get AVals for each arguments
            for (var i = 0; i < node.arguments.length; i++) {
                argAVals.push(c(node.arguments[i], curStatus, undefined));
            }
            // append current call site to the context
            var newDelta = curStatus.delta.appendOne(node['@label']);

            if (node.callee.type === 'MemberExpression') {
                // method call
                // var recv = c(node.callee.object, curStatus, undefined);
                // var methodName = immedProp(node.callee);
                // constraints.push({
                //   RECV: recv,
                //   PROPNAME: methodName,
                //   PARAMS: argAVals,
                //   RET: resAVal,
                //   EXC: curStatus.exc,
                //   DELTA: newDelta

                var _readMember2 = readMember(node.callee, curStatus, c);

                var recvAVal = _readMember2[0];
                var retAVal = _readMember2[1];

                retAVal.propagate(new cstr.IsCallee(recvAVal, argAVals, resAVal, curStatus.exc, newDelta));
            } else {
                // normal function call
                var calleeAVal = c(node.callee, curStatus, undefined);
                // callee의 return을 call expression으로
                // callee의 exception을 호출 측의 exception에 전달해야
                constraints.push({
                    CALLEE: calleeAVal,
                    SELF: rtCX.globalObject,
                    PARAMS: argAVals,
                    RET: resAVal,
                    EXC: curStatus.exc,
                    DELTA: newDelta
                });
                calleeAVal.propagate(new cstr.IsCallee(new types.AVal(rtCX.globalObject), argAVals, resAVal, curStatus.exc, newDelta));
            }
            return resAVal;
        },

        MemberExpression: function MemberExpression(node, curStatus, c) {
            var _readMember3 = readMember(node, curStatus, c);

            var retAVal = _readMember3[1];

            return retAVal;
        },

        ReturnStatement: function ReturnStatement(node, curStatus, c) {
            if (!node.argument) return;
            var ret = c(node.argument, curStatus, undefined);
            constraints.push({ FROM: ret,
                TO: curStatus.ret });
            ret.propagate(curStatus.ret);
        }
    });

    recursiveWithReturn(ast, initStatus, constraintGenerator);

    // We actually added constraints
    return true;
}

function recursiveWithReturn(node, state, visitor) {
    function c(node, st, override) {
        return visitor[override || node.type](node, st, c);
    }
    return c(node, state);
}

exports.constraints = constraints;
exports.addConstraints = addConstraints;
exports.clearConstraints = clearConstraints;
// });

},{"../domains/status":5,"../domains/types":6,"./constraints":3,"acorn/dist/walk":16}],3:[function(require,module,exports){
'use strict';

var types = require('../domains/types');
var status = require('../domains/status');
var cGen = require('./cGen');

function CSTR() {}
CSTR.prototype = Object.create(null);
CSTR.prototype.equals = function (other) {
    return this === other;
};

function ReadProp(prop, to) {
    this.prop = prop;
    this.to = to;
}
ReadProp.prototype = Object.create(CSTR.prototype);
ReadProp.prototype.addType = function (obj) {
    if (!(obj instanceof types.ObjType)) return;
    // when obj is ObjType,
    var ownProp = obj.getProp(this.prop, true);
    if (ownProp) {
        // when the object has the prop,
        ownProp.propagate(this.to);
    } else if (obj.getProp('__proto__', true)) {
        // use prototype chain
        obj.getProp('__proto__').propagate(new ReadProp(this.prop, this.to));
    }
};
ReadProp.prototype.equals = function (other) {
    if (!(other instanceof ReadProp)) return false;
    return this.prop === other.prop && this.to.equals(other.to);
};

function WriteProp(prop, from) {
    this.prop = prop;
    this.from = from;
}
WriteProp.prototype = Object.create(CSTR.prototype);
WriteProp.prototype.addType = function (obj) {
    if (!(obj instanceof types.ObjType)) return;
    var ownProp = obj.getProp(this.prop);
    this.from.propagate(ownProp);
};

function IsAdded(other, target) {
    this.other = other;
    this.target = target;
}
IsAdded.prototype = Object.create(CSTR.prototype);
IsAdded.prototype.addType = function (type) {
    if ((type === types.PrimNumber || type === types.PrimBoolean) && (this.other.hasType(types.PrimNumber) || this.other.hasType(types.PrimBoolean))) {
        this.target.addType(types.PrimNumber);
    }
    if (type === types.PrimString && !this.other.isEmpty()) {
        this.target.addType(types.PrimString);
    }
};

function IsCallee(self, args, ret, exc, delta) {
    this.self = self;
    this.args = args;
    this.ret = ret;
    this.exc = exc;
    this.delta = delta;
}
IsCallee.prototype = Object.create(CSTR.prototype);
IsCallee.prototype.addType = function (f) {
    if (!(f instanceof types.FnType)) return;
    var funEnv = f.getFunEnv(this.delta);
    var newSC = f.originNode.body['@block'].getScopeInstance(f.sc, this.delta);
    var funStatus = new status.Status(funEnv[0], funEnv[1], funEnv[2], this.delta, newSC);
    // pass this object
    this.self.propagate(funEnv[0]);

    var minLen = Math.min(this.args.length, f.paramNames.length);
    for (var i = 0; i < minLen; i++) {
        this.args[i].propagate(newSC.getAValOf(f.paramNames[i]));
    }

    // for arguments object
    if (f.originNode.body['@block'].useArgumentsObject) {
        var argObj = f.getArgumentsObject(this.delta);
        newSC.getAValOf('arguments').addType(argObj);
        for (var i = 0; i < this.args.length; i++) {
            this.args[i].propagate(argObj.getProp(i + ''));
            this.args[i].propagate(argObj.getProp(null));
        }
        argObj.getProp('callee').addType(f);
        argObj.getProp('length').addType(types.PrimNumber);
    }

    // constraint generation for the function body
    cGen.addConstraints(f.originNode.body, funStatus);

    // get return
    funEnv[1].propagate(this.ret);
    // get exception
    funEnv[2].propagate(this.exc);
};

function IsCtor(args, ret, exc, delta) {
    this.args = args;
    this.ret = ret;
    this.exc = exc;
    this.delta = delta;
}
IsCtor.prototype = Object.create(CSTR.prototype);
IsCtor.prototype.addType = function (f) {
    if (!(f instanceof types.FnType)) return;
    var funEnv = f.getFunEnv(this.delta);
    var newSC = f.originNode.body['@block'].getScopeInstance(f.sc, this.delta);
    var funStatus = new status.Status(funEnv[0], new IfObjType(funEnv[1]), funEnv[2], this.delta, newSC);
    // pass this object
    var newObj = f.getInstance();
    funEnv[0].addType(newObj);

    var minLen = Math.min(this.args.length, f.paramNames.length);
    for (var i = 0; i < minLen; i++) {
        this.args[i].propagate(newSC.getAValOf(f.paramNames[i]));
    }

    // for arguments object
    if (f.originNode.body['@block'].useArgumentsObject) {
        var argObj = f.getArgumentsObject(this.delta);
        newSC.getAValOf('arguments').addType(argObj);
        for (var i = 0; i < this.args.length; i++) {
            this.args[i].propagate(argObj.getProp(i + ''));
            this.args[i].propagate(argObj.getProp(null));
        }
        argObj.getProp('callee').addType(f);
        argObj.getProp('length').addType(types.PrimNumber);
    }

    // constraint generation for the function body
    cGen.addConstraints(f.originNode.body, funStatus);

    // by explicit return, only ObjType are propagated
    funEnv[1].propagate(this.ret);
    // return new object
    this.ret.addType(newObj);
    // get exception
    funEnv[2].propagate(this.exc);
};

// ignore non object types
function IfObjType(aval) {
    this.aval = aval;
}
IfObjType.prototype = Object.create(CSTR.prototype);
IfObjType.prototype.addType = function (type) {
    if (!(type instanceof types.ObjType)) return;
    this.aval.addType(type);
};

exports.ReadProp = ReadProp;
exports.WriteProp = WriteProp;
exports.IsAdded = IsAdded;
exports.IsCallee = IsCallee;
exports.IsCtor = IsCtor;

},{"../domains/status":5,"../domains/types":6,"./cGen":2}],4:[function(require,module,exports){
// Context for k-CFA analysis
//
// Assume a context is an array of numbers.
// A number in such list denotes a call site, that is @label of a CallExpression.
// We keep the most recent 'k' callsites.
// Equality on contexts should look into the numbers.

"use strict";

var callSiteContextParameter = {
    // maximum length of context
    maxDepthK: 0,
    // function list for sensitive analysis
    sensFuncs: {}
};

function CallSiteContext(csList) {
    if (csList) this.csList = csList;else this.csList = [];
}

CallSiteContext.prototype.equals = function (other) {
    if (this.csList.length != other.csList.length) return false;
    for (var i = 0; i < this.csList.length; i++) {
        if (this.csList[i] !== other.csList[i]) return false;
    }
    return true;
};

CallSiteContext.prototype.appendOne = function (callSite) {
    // use concat to create a new array
    // oldest one comes first
    var appended = this.csList.concat(callSite);
    if (appended.length > callSiteContextParameter.maxDepthK) {
        appended.shift();
    }
    return new CallSiteContext(appended);
};

CallSiteContext.prototype.toString = function () {
    return this.csList.toString();
};

exports.callSiteContextParameter = callSiteContextParameter;
exports.CallSiteContext = CallSiteContext;

},{}],5:[function(require,module,exports){
// Status:
// { self  : AVal,
//   ret   : AVal,
//   exc   : AVal,
//   delta : Context,
//   sc    : ScopeChain }

"use strict";

function Status(self, ret, exc, delta, sc) {
    this.self = self;
    this.ret = ret;
    this.exc = exc;
    this.delta = delta;
    this.sc = sc;
}

Status.prototype.equals = function (other) {
    return this.self === other.self && this.ret === other.ret && this.exc === other.exc && this.delta.equals(other.delta) && this.sc === other.sc;
};

exports.Status = Status;

},{}],6:[function(require,module,exports){
'use strict';

// for DEBUG

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var count = 0;
/**
 * the abstract value for a concrete value
 * which is a set of types.
 * @constructor
 * @param {Type} type - give a type to make AVal with a single type
 */
function AVal(type) {
    // type: contained types
    // We assume types are distinguishable by '==='
    if (type) this.types = new Set([type]);else this.types = new Set();
    // forwards: propagation targets
    // We assume targets are distinguishable by 'equals' method
    this.forwards = new Set();
    // for DEBUG
    this._id = count++;
}
/** Check whether it has any type
 * @returns {boolean}
 */
AVal.prototype.isEmpty = function () {
    return this.types.size === 0;
};

/**
 * @returns {[Type]}
 */
AVal.prototype.getTypes = function () {
    return this.types;
};

/**
 * @returns {boolean}
 */
AVal.prototype.hasType = function (type) {
    return this.types.has(type);
};

/**
 * Add a type.
 * @param {Type} type
 */
AVal.prototype.addType = function (type) {
    if (this.types.has(type)) return;
    // given type is new
    this.types.add(type);
    // send to propagation targats
    this.forwards.forEach(function (fwd) {
        fwd.addType(type);
    });
};
/**
 * @param {AVal} target
 */
AVal.prototype.propagate = function (target) {
    if (!this.addForward(target)) return;
    // target is newly added
    // send types to the new target
    this.types.forEach(function (type) {
        target.addType(type);
    });
};

AVal.prototype.addForward = function (fwd) {
    for (var _iterator = this.forwards, _isArray = Array.isArray(_iterator), _i = 0, _iterator = _isArray ? _iterator : _iterator[Symbol.iterator]();;) {
        var _ref;

        if (_isArray) {
            if (_i >= _iterator.length) break;
            _ref = _iterator[_i++];
        } else {
            _i = _iterator.next();
            if (_i.done) break;
            _ref = _i.value;
        }

        var oldFwd = _ref;

        if (fwd.equals(oldFwd)) return false;
    }
    this.forwards.add(fwd);
    return true;
};

AVal.prototype.equals = function (other) {
    // simple reference comparison
    return this === other;
};

/**
 * TODO: check whether we really need this method.
 * @param {string} prop
 * @returns {AVal}
 */
AVal.prototype.getProp = function (prop) {
    if (prop === '✖') {
        // ✖ is the bogus property name added for error recovery.
        return AValNull;
    }
    if (this.props.has(prop)) {
        return this.props.get(prop);
    } else {
        return AValNull;
    }
};

/**
 * the super class of all types
 * each type should be distinguishable by '===' operation.
 * @constructor
 */
function Type(name) {
    this.name = name;
}
Type.prototype = Object.create(null);
Type.prototype.getName = function () {
    return this.name;
};

/**
 * 1. object types
 * @param {AVal} proto - AVal of constructor's prototype
 * @param {string} name - guessed name
 */
function ObjType(proto, name) {
    this.name = name;
    this.props = new Map();

    // share proto with __proto__
    this.setProp('__proto__', proto);
}
ObjType.prototype = Object.create(Type.prototype);
/**
 * @param {string|null} prop - null for computed props
 * @param {boolean} readOnly - if false, create AVal for prop if necessary
 * @returns {AVal} AVal of the property
 */
ObjType.prototype.getProp = function (prop, readOnly) {
    if (prop === '✖') {
        // ✖ is the bogus property name added during parsing error recovery.
        return AValNull;
    }
    if (this.props.has(prop)) {
        return this.props.get(prop);
    } else if (readOnly) {
        return null;
    } else {
        var newPropAVal = new AVal();
        this.props.set(prop, newPropAVal);
        return newPropAVal;
    }
};
/**
 * We use this function to share .prototype with instances __proto__
 * It is possible to use this function to merge AVals to optimize the analyzer.
 * @param {string|null} prop - null for computed props
 * @param {AVal} aval
 */
ObjType.prototype.setProp = function (prop, aval) {
    if (prop === '✖') {
        // ✖ is the bogus property name added during parsing error recovery.
        return;
    }
    this.props.set(prop, aval);
};
/**
 * TODO: Check this function's necessity
 * @param {string} prop
 * @returns {boolean}
 */
ObjType.prototype.hasProp = function (prop) {
    if (prop === '✖') return false;
    return this.props.has(prop);
};
/**
 * TODO: Check this function's necessity
 * @param {Type} type
 * @param {string} prop
 */
ObjType.prototype.addTypeToProp = function (type, prop) {
    if (prop === '✖') return;
    if (!this.props.has(prop)) {
        this.props.set(prop, new AVal());
    }
    if (this.props.get(prop).hasType(type)) return;
    this.props.get(prop).addType(type);
};
/**
 * TODO: Check this function's necessity
 * @param {AVal} aval
 * @param {string} prop
 */
ObjType.prototype.joinAValToProp = function (aval, prop) {
    var self = this;
    aval.getTypes().forEach(function (type) {
        self.addTypeToProp(type, prop);
    });
};

// make an Obj from the global scope
function mkObjFromGlobalScope(gScope) {
    var gObj = new ObjType(AValNull, '*global scope*');
    gObj.props = gScope.varMap;
    // Override getProp method for global object
    // We ignore 'readOnly' parameter to always return its own prop AVal
    gObj.getProp = function (prop) {
        return ObjType.prototype.getProp.call(this, prop);
    };
    return gObj;
}

/**
 * 2. primitive types
 * @constructor
 * @param {string} name
 */
function PrimType(name) {
    this.name = name;
}
PrimType.prototype = Object.create(Type.prototype);

/**
 * 3. function types
 * the name is used for the type of the instances from the function
 * @constructor
 * @param {AVal} fn_proto - AVal for constructor's .prototype
 * @param {string} name - guessed name
 * @param {[string]} argNames - list of parameter names
 * @param {Scope} sc - functions scope chain, or closure
 * @param {node} originNode - AST node for the function
 * @param {Type} argProto - prototype for arguments object
 */
function FnType(fn_proto, name, argNames, sc, originNode, argProto) {
    ObjType.call(this, fn_proto, name);
    this.paramNames = argNames;
    this.sc = sc;
    this.originNode = originNode;
    this.argProto = argProto;
    // funEnv : CallContext -> [self, ret, exc]
    this.funEnv = new Map();
}
FnType.prototype = Object.create(ObjType.prototype);

/**
 * construct Status for function
 * @param {CallContext} delta - call context
 * @returns {[AVal, AVal, AVal]} - for self, return and exception AVals
 */
FnType.prototype.getFunEnv = function (delta) {
    if (this.funEnv.has(delta)) {
        return this.funEnv.get(delta);
    } else {
        var triple = [new AVal(), new AVal(), new AVal()];
        this.funEnv.set(delta, triple);
        return triple;
    }
};

FnType.prototype.getArgumentsObject = function (delta) {
    this.argObjMap = this.argObjMap || new Map();
    if (this.argObjMap.has(delta)) {
        return this.argObjMap.get(delta);
    } else {
        var argObj = new ObjType(new AVal(this.argProto), '*arguments object*');
        this.argObjMap.set(delta, argObj);
        return argObj;
    }
};

/**
 * get Object made by the function
 * TODO: use additional information to create multiple instances
 * @returns {ObjType}
 */
FnType.prototype.getInstance = function () {
    // objInstance is the object made by the functioann
    if (this.objInstance) return this.objInstance;
    // we unify constructor's .prototype and instance's __proto__
    this.objInstance = new ObjType(this.getProp('prototype'));
    return this.objInstance;
};

/** 
 * 4. array types
 * @constructor
 */
function ArrType(arr_proto) {
    ObjType.call(this, arr_proto, 'Array');
}
ArrType.prototype = Object.create(ObjType.prototype);

// Make primitive types
var PrimNumber = new PrimType('number');
var PrimString = new PrimType('string');
var PrimBoolean = new PrimType('boolean');

// AbsNull represents all empty abstract values.
var AValNull = new AVal();
// You should not add any properties to it.
AValNull.props = null;
// Adding types are ignored.
AValNull.addType = function () {};

var AbsCache = (function () {
    function AbsCache() {
        _classCallCheck(this, AbsCache);

        this.map = new Map();
    }

    // export

    /**
     * Get if one exists, if not create one
     * @param loc
     * @param ctx
     * @returns {*}
     */

    AbsCache.prototype.get = function get(loc, ctx) {
        if (!this.map.has(loc)) {
            // create inner map
            this.map.set(loc, new Map());
        }
        var mapLoc = this.map.get(loc);
        if (!mapLoc.has(ctx)) {
            var av = new AVal();
            mapLoc.set(ctx, av);
            return av;
        } else {
            return mapLoc.get(ctx);
        }
    };

    /**
     * To use av made by others (e.g. scope)
     * @param loc
     * @param ctx
     * @param av
     */

    AbsCache.prototype.set = function set(loc, ctx, av) {
        if (!this.map.has(loc)) {
            // create inner map
            this.map.set(loc, new Map());
        }
        this.map.get(loc).set(ctx, av);
    };

    /**
     * Check whether it has one for loc and ctx
     * @param loc
     * @param ctx
     * @returns {boolean}
     */

    AbsCache.prototype.has = function has(loc, ctx) {
        return this.map.has(loc) && this.map.get(loc).has(ctx);
    };

    /**
     * Get all the types of the loc
     * @param loc
     * @returns [Type]
     */

    AbsCache.prototype.getTypeOfLoc = function getTypeOfLoc(loc) {
        if (!this.map.has(loc)) {
            // no type is available
            return null;
        }
        var tps = [];
        for (var _iterator2 = this.map.get(loc).values(), _isArray2 = Array.isArray(_iterator2), _i2 = 0, _iterator2 = _isArray2 ? _iterator2 : _iterator2[Symbol.iterator]();;) {
            var _ref2;

            if (_isArray2) {
                if (_i2 >= _iterator2.length) break;
                _ref2 = _iterator2[_i2++];
            } else {
                _i2 = _iterator2.next();
                if (_i2.done) break;
                _ref2 = _i2.value;
            }

            var av = _ref2;

            for (var _iterator3 = av.getTypes(), _isArray3 = Array.isArray(_iterator3), _i3 = 0, _iterator3 = _isArray3 ? _iterator3 : _iterator3[Symbol.iterator]();;) {
                var _ref3;

                if (_isArray3) {
                    if (_i3 >= _iterator3.length) break;
                    _ref3 = _iterator3[_i3++];
                } else {
                    _i3 = _iterator3.next();
                    if (_i3.done) break;
                    _ref3 = _i3.value;
                }

                var tp = _ref3;

                if (tps.indexOf(tp) === -1) {
                    tps.push(tp);
                }
            }
        }
        return tps;
    };

    return AbsCache;
})();

exports.Type = Type;
exports.ObjType = ObjType;
exports.FnType = FnType;
exports.ArrType = ArrType;
exports.PrimNumber = PrimNumber;
exports.PrimString = PrimString;
exports.PrimBoolean = PrimBoolean;
exports.mkObjFromGlobalScope = mkObjFromGlobalScope;

exports.AVal = AVal;
exports.AValNull = AValNull;

exports.AbsCache = AbsCache;

},{}],7:[function(require,module,exports){
'use strict';

var myWalker = require('./util/myWalker');

function getTypeData(ast, Ĉ, start, end) {
    'use strict';
    var node = myWalker.findSurroundingNode(ast, start, end);
    var nodeTypes = Ĉ.getTypeOfLoc(node);
    var hasType = undefined;
    var typeString = '';
    if (!nodeTypes) {
        hasType = false;
        typeString = 'No expression at the given range';
    } else {
        hasType = true;
        typeString = '';
        nodeTypes.forEach(function (tp, i) {
            typeString += tp.getName();
            if (i !== nodeTypes.length - 1) {
                typeString += ', ';
            }
        });
    }
    return {
        hasType: hasType,
        typeString: typeString,
        nodeStart: node.start,
        nodeEnd: node.end
    };
}

exports.getTypeData = getTypeData;

},{"./util/myWalker":11}],8:[function(require,module,exports){
// import necessary libraries
'use strict';

var acorn = require('acorn/dist/acorn');
var acorn_loose = require('acorn/dist/acorn_loose');
var aux = require('./aux');
var types = require('./domains/types');
var context = require('./domains/context');
var status = require('./domains/status');
var varBlock = require('./varBlock');
var cGen = require('./constraint/cGen');
var varRefs = require('./varrefs');
var retOccur = require('./retOccur');
var thisOccur = require('./thisOccur');
var myWalker = require('./util/myWalker');
var getTypeData = require('./getTypeData');

function analyze(input, retAll) {
    // the Scope object for global scope
    // scope.Scope.globalScope = new scope.Scope(null);

    // parsing input program
    var ast;
    var acornOptions = { ecmaVersion: 6 };
    try {
        ast = acorn.parse(input, acornOptions);
    } catch (e) {
        ast = acorn_loose.parse_dammit(input, acornOptions);
    }

    var nodeArrayIndexedByList = aux.getNodeList(ast);

    // Show AST before scope resolution
    // aux.showUnfolded(ast);

    varBlock.annotateBlockInfo(ast);
    var gBlock = ast['@block'];
    var initialContext = new context.CallSiteContext();
    var gScope = gBlock.getScopeInstance(null, initialContext);
    var gObject = types.mkObjFromGlobalScope(gScope);
    var initStatus = new status.Status(gObject, types.AValNull, types.AValNull, initialContext, gScope);
    // the prototype object of Object
    var ObjProto = new types.ObjType(null, 'Object.prototype');
    var rtCX = {
        globalObject: gObject,
        // temporal
        protos: {
            Object: ObjProto,
            Function: new types.ObjType(new types.AVal(ObjProto), 'Function.prototype'),
            Array: new types.ObjType(new types.AVal(ObjProto), 'Array.prototype'),
            RegExp: new types.ObjType(new types.AVal(ObjProto), 'RegExp.prototype'),
            String: new types.ObjType(new types.AVal(ObjProto), 'String.prototype'),
            Number: new types.ObjType(new types.AVal(ObjProto), 'Number.prototype'),
            Boolean: new types.ObjType(new types.AVal(ObjProto), 'Boolean.prototype')
        },
        Ĉ: new types.AbsCache()
    };
    cGen.addConstraints(ast, initStatus, rtCX);
    var constraints = cGen.constraints;
    //aux.showUnfolded(gBlockAndAnnotatedAST.ast);
    // aux.showUnfolded(constraints);
    // aux.showUnfolded(gBlock);
    // console.log(util.inspect(gBlock, {depth: 10}));
    if (retAll) {
        return {
            gObject: gObject,
            AST: ast,
            gBlock: gBlock,
            gScope: gScope,
            Ĉ: rtCX.Ĉ
        };
    } else {
        return gObject;
    }
}

exports.analyze = analyze;
exports.findIdentifierAt = varRefs.findIdentifierAt;
exports.findVarRefsAt = varRefs.findVarRefsAt;
exports.onFunctionOrReturnKeyword = retOccur.onFunctionOrReturnKeyword;
exports.findReturnStatements = retOccur.findReturnStatements;
exports.onThisKeyword = thisOccur.onThisKeyword;
exports.findThisExpressions = thisOccur.findThisExpressions;
exports.findSurroundingNode = myWalker.findSurroundingNode;
exports.getTypeData = getTypeData.getTypeData;

},{"./aux":1,"./constraint/cGen":2,"./domains/context":4,"./domains/status":5,"./domains/types":6,"./getTypeData":7,"./retOccur":9,"./thisOccur":10,"./util/myWalker":11,"./varBlock":12,"./varrefs":13,"acorn/dist/acorn":14,"acorn/dist/acorn_loose":15}],9:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');
var myWalker = require('./util/myWalker');

/**
 * Check whether given pos is on a function keyword
 * @param ast - AST of a program
 * @param pos - index position
 * @returns {*} - function node or null
 */
function onFunctionOrReturnKeyword(ast, pos) {
    "use strict";

    // find function node
    // st is the enclosing function
    var walker = myWalker.wrapWalker(walk.base,
    // pre
    function (node, st) {
        if (node.start > pos || node.end < pos) {
            return false;
        }

        // on a function keyword, 8 is the length of 'function'
        // or on return keyword, 6 is the length of 'return'
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && (node.start <= pos && pos <= node.start + 8) || node.type === 'ReturnStatement' && (node.start <= pos && pos <= node.start + 6)) {
            throw st;
        }
        return true;
    },
    // post
    undefined,
    // stChange
    function (node, st) {
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            return node;
        } else {
            return st;
        }
    });

    try {
        walk.recursive(ast, undefined, walker);
    } catch (e) {
        if (e && e.type && (e.type === 'FunctionExpression' || e.type === 'FunctionDeclaration')) {
            return e;
        } else {
            throw e;
        }
    }
    // identifier not found
    return null;
}

/**
 * Given a function node, find its return nodes
 *
 * @param fNode - AST node of a function, possibly with no annotation
 * @returns {*} - array of AST nodes
 */
function getReturnNodes(fNode) {
    "use strict";
    var rets = [];
    if (fNode.type !== 'FunctionExpression' && fNode.type !== 'FunctionDeclaration') {
        throw Error('fNode should be a function node');
    }

    var walker = walk.make({
        ReturnStatement: function ReturnStatement(node) {
            return rets.push(node);
        },
        Function: function Function() {
            // not visit inner functions
        }
    }, walk.base);

    walk.recursive(fNode.body, undefined, walker);

    return rets;
}

/**
 * Find return nodes corresponding to the position
 * if the pos is on a function keyword
 *
 * @param ast - AST node of a program, possibly with no annotation
 * @param pos - cursor position
 * @param includeFunctionKeyword - whether to include function keyword range
 * @returns {Array} - array of AST nodes of return statements
 */
function findReturnStatements(ast, pos, includeFunctionKeyword) {
    "use strict";

    var fNode = onFunctionOrReturnKeyword(ast, pos);
    if (!fNode) {
        // pos is not on function keyword
        return null;
    }

    var rets = getReturnNodes(fNode);
    // when function does not have return statements,
    // indicate it by the closing brace of the function body
    if (rets.length === 0) {
        rets.push({ start: fNode.end - 1, end: fNode.end });
    }
    if (includeFunctionKeyword) {
        rets.push({ start: fNode.start, end: fNode.start + 8 });
    }
    return rets;
}

exports.onFunctionOrReturnKeyword = onFunctionOrReturnKeyword;
exports.findReturnStatements = findReturnStatements;

},{"./util/myWalker":11,"acorn/dist/walk":16}],10:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');
var myWalker = require('./util/myWalker');

/**
 * Check whether given pos is on a this keyword
 * @param ast - AST of a program
 * @param pos - index position
 * @returns {*} - function node or null
 */
function onThisKeyword(ast, pos) {
    "use strict";

    // find function node
    // st is the enclosing function
    var walker = myWalker.wrapWalker(walk.base,
    // pre
    function (node, st) {
        if (node.start > pos || node.end < pos) {
            return false;
        }

        if (node.type === 'ThisExpression') {
            throw st;
        }
        return true;
    },
    // post
    undefined,
    // stChange
    function (node, st) {
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            return node;
        } else {
            return st;
        }
    });

    try {
        walk.recursive(ast, undefined, walker);
    } catch (e) {
        if (e && e.type && (e.type === 'FunctionExpression' || e.type === 'FunctionDeclaration')) {
            return e;
        } else {
            throw e;
        }
    }
    // identifier not found
    return null;
}

/**
 * Given a function node, find its this nodes
 *
 * @param fNode - AST node of a function, possibly with no annotation
 * @returns {*} - array of AST nodes
 */
function getThisNodes(fNode) {
    "use strict";
    var rets = [];
    if (fNode.type !== 'FunctionExpression' && fNode.type !== 'FunctionDeclaration') {
        throw Error('fNode should be a function node');
    }

    var walker = walk.make({
        ThisExpression: function ThisExpression(node) {
            return rets.push(node);
        },
        Function: function Function() {
            // not visit inner functions
        }
    }, walk.base);

    walk.recursive(fNode.body, undefined, walker);

    return rets;
}

/**
 * Find this nodes if the pos is on a this keyword
 *
 * @param ast - AST node of a program, possibly with no annotation
 * @param pos - cursor position
 * @param includeFunctionKeyword - whether to include function keyword range
 * @returns {Array} - array of AST nodes of return statements
 */
function findThisExpressions(ast, pos, includeFunctionKeyword) {
    "use strict";

    var fNode = onThisKeyword(ast, pos);
    if (!fNode) {
        // pos is not on this keyword
        return null;
    }

    var rets = getThisNodes(fNode);
    if (includeFunctionKeyword) {
        rets.push({ start: fNode.start, end: fNode.start + 8 });
    }
    return rets;
}

exports.onThisKeyword = onThisKeyword;
exports.findThisExpressions = findThisExpressions;

},{"./util/myWalker":11,"acorn/dist/walk":16}],11:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');

/**
 * a walker that visits each id even though it is var declaration
 * the parameter vb denote varBlock
 */
var varWalker = walk.make({
    Function: function Function(node, vb, c) {
        'use strict';
        var innerVb = node.body['@block'];
        if (node.id) c(node.id, innerVb);
        for (var i = 0; i < node.params.length; i++) {
            c(node.params[i], innerVb);
        }c(node.body, innerVb);
    },
    TryStatement: function TryStatement(node, vb, c) {
        c(node.block, vb);
        if (node.handler) {
            c(node.handler, vb);
        }
        if (node.finalizer) {
            c(node.finalizer, vb);
        }
    },
    CatchClause: function CatchClause(node, vb, c) {
        var catchVb = node.body['@block'];
        c(node.param, catchVb);
        c(node.body, catchVb);
    },
    VariableDeclaration: function VariableDeclaration(node, vb, c) {
        'use strict';
        for (var i = 0; i < node.declarations.length; ++i) {
            var decl = node.declarations[i];
            c(decl.id, vb);
            if (decl.init) c(decl.init, vb);
        }
    },
    VariablePattern: function VariablePattern(node, vb, c) {
        'use strict';
        c(node, vb, 'Identifier');
    }
});

/**
 * Wrap a walker with pre- and post- actions
 *
 * @param preNode - Apply before visiting the current node.
 * If returns false, do not visit the node.
 * @param postNode - Apply after visiting the current node.
 * If given, return values are overridden.
 * @returns {*} - a new walker
 */
function wrapWalker(walker, preNode, postNode, stChange) {
    'use strict';
    var retWalker = {};
    // wrapping each function preNode and postNode

    var _loop = function (nodeType) {
        if (!walker.hasOwnProperty(nodeType)) {
            return 'continue';
        }
        retWalker[nodeType] = function (node, st, c) {
            var ret = undefined;
            var newSt = st;
            if (stChange) {
                newSt = stChange(node, st);
            }
            if (!preNode || preNode(node, newSt, c)) {
                ret = walker[nodeType](node, newSt, c);
            } else {
                return;
            }
            if (postNode) {
                ret = postNode(node, newSt, c);
            }
            return ret;
        };
    };

    for (var nodeType in walker) {
        var _ret = _loop(nodeType);

        if (_ret === 'continue') continue;
    }
    return retWalker;
}

function findSurroundingNode(ast, start, end) {
    "use strict";
    function Found(node) {
        this.node = node;
    }

    var walker = wrapWalker(varWalker, function (node) {
        return !(node.start > start || node.end < end);
    }, function (node) {
        throw new Found(node);
    });

    try {
        walk.recursive(ast, undefined, walker);
    } catch (e) {
        if (e instanceof Found) {
            return e.node;
        } else {
            throw e;
        }
    }
    // node not found
    return null;
}

exports.wrapWalker = wrapWalker;
exports.varWalker = varWalker;
exports.findSurroundingNode = findSurroundingNode;

},{"acorn/dist/walk":16}],12:[function(require,module,exports){
/*
 JavaScript는 global, function block, catch block에 변수가 달린다.
 ES6는 일반 block에도 달린다.

 VarBlock는 각 block에 달린 변수들을 나타낸다.
 - paren      : BlockVars, 바깥 block을 나타내는 객체
 - originLabel: number, 해당 BlockVars가 선언된 AST node의 @label
    origin이 될 수 있는 node는
    Function.body, CatchClause.block 두가지다.
    두가지 모두 BlockStatement이다.
 - isCatch    : boolean,
   * true  -> catch block
   * false -> function block, or global

 - paramVarNames : 매개변수 이름 목록, 매개 변수 순서대로
 - localVarNames : 지역 변수 이름 목록, 순서 무의미
    arguments를 사용하는 경우 localVarNames에 등장하고,
    arguments object를 사용하면 useArgumentsObject == true

 - (optional) useArgumentsObject: boolean
    함수 body block인 경우에만 사용 가능
    * true  : arguments object가 사용되었다.
      즉 함수 body에서 변수 arguments를 선언 없이 사용했다.
      이 경우, arguments는 함수의 지역 변수로 등록된다.
    * false 인 경우는 없다. 그럴거면 아예 변수 자체가 없다.

 - usedVariables : 각 block의 매개변수, 지역변수 중
   사용되는 위치가 있는 것들의 목록

 - instances : Delta -> VarBlock의 변수들 -> AVal
   getInstance(delta) 를 통해 같은 delta는 같은 mapping 주게 만듬

 - scopeInstances : [Scope]
   현재 VarBlock을 마지막으로 하는 Scope를 모두 모은다.
   getScopeInstance(delta, paren) 을 통해 같은 scope chain은
   같은 객체가 되도록 만든다.
*/
'use strict';

var types = require('./domains/types');
var walk = require('acorn/dist/walk');
var aux = require('./aux');

function VarBlock(paren, originNode, isCatch) {
    this.paren = paren;
    this.originNode = originNode;
    this.originLabel = originNode['@label'];
    this.isCatch = isCatch;
    this.paramVarNames = [];
    this.localVarNames = [];

    this.usedVariables = [];
    // this.useArgumentsObject
    this.instances = Object.create(null);
    this.scopeInstances = [];
}

VarBlock.prototype = Object.create(null);

VarBlock.prototype.isGlobal = function () {
    return this.paren == null;
};
VarBlock.prototype.isFunction = function () {
    return this.paren != null && this.localVarNames != null;
};
VarBlock.prototype.isCatchBlock = function () {
    return this.isCatch;
};

VarBlock.prototype.getLocalVarNames = function () {
    return this.localVarNames;
};
VarBlock.prototype.getParamVarNames = function () {
    return this.paramVarNames;
};
VarBlock.prototype.hasLocalVar = function (varName) {
    return this.localVarNames && this.localVarNames.indexOf(varName) > -1;
};
VarBlock.prototype.hasParamVar = function (varName) {
    return this.paramVarNames.indexOf(varName) > -1;
};
VarBlock.prototype.hasVar = function (varName) {
    return this.hasParamVar(varName) || this.hasLocalVar(varName);
};

VarBlock.prototype.addDeclaredLocalVar = function (varName, isFunDecl) {
    var currBlock = this;
    // peel off initial catch blocks
    // for function decl, skip any catch blocks,
    // for variable decl, skip catch block with different varName.
    while (currBlock.isCatchBlock() && (isFunDecl || !currBlock.hasParamVar(varName))) {
        currBlock = currBlock.paren;
    }
    // if already added, do not add
    if (!currBlock.hasVar(varName)) {
        currBlock.localVarNames.push(varName);
    }
    // returns the block object that contains the variable
    return currBlock;
};
VarBlock.prototype.addParamVar = function (varName) {
    this.paramVarNames.push(varName);
};
VarBlock.prototype.findVarInChain = function (varName) {
    var currBlock = this;
    while (currBlock && currBlock.paren && !currBlock.hasVar(varName)) {
        currBlock = currBlock.paren;
    }
    // if not found, it will return the global
    return currBlock;
};

VarBlock.prototype.addUsedVar = function (varName) {
    if (this.usedVariables.indexOf(varName) === -1) {
        this.usedVariables.push(varName);
    }
};
VarBlock.prototype.getUsedVarNames = function () {
    return this.usedVariables;
};
VarBlock.prototype.isUsedVar = function (varName) {
    return this.usedVariables.indexOf(varName) > -1;
};

// returns a mapping
VarBlock.prototype.getInstance = function (delta) {
    if (this.instances[delta]) {
        return this.instances[delta];
    }
    // construct VarMap
    var varMap = new Map();
    var varNames = this.getParamVarNames().concat(this.getLocalVarNames());

    for (var i = 0; i < varNames.length; i++) {
        varMap.set(varNames[i], new types.AVal());
    }
    // remember the instance
    this.instances[delta] = varMap;
    return varMap;
};
// returns an array
VarBlock.prototype.getParamAVals = function (delta) {
    var instance = this.getInstance(delta);
    var params = [];
    this.getParamVarNames().forEach(function (name) {
        params.push(instance[aux.internalName(name)]);
    });
    return params;
};
// returns an AVal
VarBlock.prototype.getArgumentsAVal = function (delta) {
    if (!this.useArgumentsObject) {
        throw new Error('Not for this VarBlock');
    }
    return this.getInstance(delta)[aux.internalName('arguments')];
};

// get a Scope instance
VarBlock.prototype.getScopeInstance = function (paren, delta) {
    var varMap = this.getInstance(delta);
    var found = null;

    this.scopeInstances.forEach(function (sc) {
        if (sc.paren === paren && sc.varMap === varMap) found = sc;
    });

    if (found) {
        return found;
    } else {
        var newScopeInstance = new Scope(paren, varMap, this);
        this.scopeInstances.push(newScopeInstance);
        return newScopeInstance;
    }
};

var declaredVariableFinder = walk.make({
    Function: function Function(node, currBlock, c) {
        var parenBlock = currBlock;
        if (node.id) {
            var funcName = node.id.name;
            parenBlock = currBlock.addDeclaredLocalVar(funcName, true);
        }
        // create a VarBlock for function
        var funcBlock = new VarBlock(parenBlock, node);
        node.body['@block'] = funcBlock;
        // add function parameters to the scope
        for (var i = 0; i < node.params.length; i++) {
            var paramName = node.params[i].name;
            funcBlock.addParamVar(paramName);
        }
        c(node.body, funcBlock, undefined);
    },
    VariableDeclaration: function VariableDeclaration(node, currBlock, c) {
        for (var i = 0; i < node.declarations.length; i++) {
            var decl = node.declarations[i];
            var name = decl.id.name;
            currBlock.addDeclaredLocalVar(name);
        }
        if (decl.init) c(decl.init, currBlock, undefined);
    },
    TryStatement: function TryStatement(node, currScope, c) {
        c(node.block, currScope, undefined);
        if (node.handler) {
            c(node.handler, currScope, undefined);
        }
        if (node.finalizer) {
            c(node.finalizer, currScope, undefined);
        }
    },
    CatchClause: function CatchClause(node, currBlock, c) {
        var catchBlock = new VarBlock(currBlock, node, true);
        catchBlock.addParamVar(node.param.name);
        node.body['@block'] = catchBlock;
        c(node.body, catchBlock, undefined);
    }
});

// For variables in global and arguments in functions
var variableUsageCollector = walk.make({
    VariablePattern: function VariablePattern(node, currBlock, c) {
        c(node, currBlock, 'Identifier');
    },

    Identifier: function Identifier(node, currBlock, c) {
        var containingBlock,
            varName = node.name;
        if (varName !== 'arguments') {
            containingBlock = currBlock.findVarInChain(varName);
            if (containingBlock.isGlobal()) {
                containingBlock.addDeclaredLocalVar(varName);
            }
            containingBlock.addUsedVar(varName);
        } else {
            // varName == 'arguments'
            containingBlock = currBlock;
            while (containingBlock.isCatchBlock() && !containingBlock.hasParamVar(varName)) {
                containingBlock = containingBlock.paren;
            }
            if (containingBlock.hasVar(varName)) {
                // arguments is explicitly declared
                containingBlock.addUsedVar(varName);
            } else {
                // arguments is not explicitly declared
                // add it as local variable
                containingBlock.addDeclaredLocalVar(varName);
                // also it is used
                containingBlock.addUsedVar(varName);
                if (containingBlock.isFunction()) {
                    containingBlock.useArgumentsObject = true;
                }
            }
        }
    },

    ReturnStatement: function ReturnStatement(node, currBlock, c) {
        var functionBlock = currBlock;
        while (functionBlock.isCatchBlock()) {
            functionBlock = functionBlock.paren;
        }
        if (!functionBlock.isGlobal() && node.argument !== null) {
            functionBlock.useReturnWithArgument = true;
        }
        if (node.argument) {
            c(node.argument, currBlock, undefined);
        }
    },

    ScopeBody: function ScopeBody(node, currBlock, c) {
        c(node, node['@block'] || currBlock);
    }
});

function annotateBlockInfo(ast, gBlock) {
    if (!gBlock) {
        // when global block is not given, create
        gBlock = new VarBlock(null, ast);
    }
    ast['@block'] = gBlock;
    walk.recursive(ast, gBlock, null, declaredVariableFinder);
    walk.recursive(ast, gBlock, null, variableUsageCollector);
    return ast;
}

// define scope object
function Scope(paren, varMap, vb) {
    this.paren = paren;
    this.varMap = varMap;
    this.vb = vb;
}
Scope.prototype = Object.create(null);
// find AVal of a variable in the chain
Scope.prototype.getAValOf = function (varName) {
    var curr = this;
    while (curr != null) {
        if (curr.varMap.has(varName)) {
            return curr.varMap.get(varName);
        }
        curr = curr.paren;
    }
    throw new Error('Should have found the variable');
};
// remove initial catch scopes from the chain
Scope.prototype.removeInitialCatchBlocks = function () {
    var curr = this;
    while (curr.vb.isCatchBlock()) {
        curr = curr.paren;
    }
    return curr;
};

exports.VarBlock = VarBlock;
exports.annotateBlockInfo = annotateBlockInfo;
exports.Scope = Scope;

},{"./aux":1,"./domains/types":6,"acorn/dist/walk":16}],13:[function(require,module,exports){
'use strict';

var walk = require('acorn/dist/walk');
var myWalker = require('./util/myWalker');

function findIdentifierAt(ast, pos) {
    "use strict";

    function Found(node, state) {
        this.node = node;
        this.state = state;
    }

    // find the node
    var walker = myWalker.wrapWalker(myWalker.varWalker, function (node, vb) {
        if (node.start > pos || node.end < pos) {
            return false;
        }
        if (node.type === 'Identifier' && node.name !== '✖') {
            throw new Found(node, vb);
        }
        return true;
    });

    try {
        walk.recursive(ast, ast['@block'], walker);
    } catch (e) {
        if (e instanceof Found) {
            return e;
        } else {
            throw e;
        }
    }
    // identifier not found
    return null;
}

/**
 *
 * @param ast - scope annotated AST
 * @param {number} pos - character position
 * @returns {*} - array of AST nodes
 */
function findVarRefsAt(ast, pos) {
    "use strict";
    var found = findIdentifierAt(ast, pos);
    if (!found) {
        // pos is not at a variable
        return null;
    }
    // find refs for the id node
    var refs = findRefsToVariable(ast, found);

    return refs;
}

/**
 *
 * @param ast - scope annotated AST
 * @param found - node and varBlock of the variable
 * @returns {Array} - array of AST nodes
 */
function findRefsToVariable(ast, found) {
    "use strict";
    var varName = found.node.name;
    var vb1 = found.state.findVarInChain(varName);
    var refs = [];

    var walker = walk.make({
        Identifier: function Identifier(node, vb) {
            if (node.name !== varName) return;
            if (vb1 === vb.findVarInChain(varName)) {
                refs.push(node);
            }
        }
    }, myWalker.varWalker);

    walk.recursive(vb1.originNode, vb1, walker);
    return refs;
}

exports.findIdentifierAt = findIdentifierAt;
exports.findVarRefsAt = findVarRefsAt;

},{"./util/myWalker":11,"acorn/dist/walk":16}],14:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.acorn = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
// A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _identifier = _dereq_("./identifier");

var _util = _dereq_("./util");

var pp = _state.Parser.prototype;

// Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.

pp.checkPropClash = function (prop, propHash) {
  if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) return;
  var key = prop.key,
      name = undefined;
  switch (key.type) {
    case "Identifier":
      name = key.name;break;
    case "Literal":
      name = String(key.value);break;
    default:
      return;
  }
  var kind = prop.kind;
  if (this.options.ecmaVersion >= 6) {
    if (name === "__proto__" && kind === "init") {
      if (propHash.proto) this.raise(key.start, "Redefinition of __proto__ property");
      propHash.proto = true;
    }
    return;
  }
  var other = undefined;
  if (_util.has(propHash, name)) {
    other = propHash[name];
    var isGetSet = kind !== "init";
    if ((this.strict || isGetSet) && other[kind] || !(isGetSet ^ other.init)) this.raise(key.start, "Redefinition of property");
  } else {
    other = propHash[name] = {
      init: false,
      get: false,
      set: false
    };
  }
  other[kind] = true;
};

// ### Expression parsing

// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.

// Parse a full expression. The optional arguments are used to
// forbid the `in` operator (in for loops initalization expressions)
// and provide reference for storing '=' operator inside shorthand
// property assignment in contexts where both object expression
// and object pattern might appear (so it's possible to raise
// delayed syntax error at correct position).

pp.parseExpression = function (noIn, refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseMaybeAssign(noIn, refShorthandDefaultPos);
  if (this.type === _tokentype.types.comma) {
    var node = this.startNodeAt(startPos, startLoc);
    node.expressions = [expr];
    while (this.eat(_tokentype.types.comma)) node.expressions.push(this.parseMaybeAssign(noIn, refShorthandDefaultPos));
    return this.finishNode(node, "SequenceExpression");
  }
  return expr;
};

// Parse an assignment expression. This includes applications of
// operators like `+=`.

pp.parseMaybeAssign = function (noIn, refShorthandDefaultPos, afterLeftParse) {
  if (this.type == _tokentype.types._yield && this.inGenerator) return this.parseYield();

  var failOnShorthandAssign = undefined;
  if (!refShorthandDefaultPos) {
    refShorthandDefaultPos = { start: 0 };
    failOnShorthandAssign = true;
  } else {
    failOnShorthandAssign = false;
  }
  var startPos = this.start,
      startLoc = this.startLoc;
  if (this.type == _tokentype.types.parenL || this.type == _tokentype.types.name) this.potentialArrowAt = this.start;
  var left = this.parseMaybeConditional(noIn, refShorthandDefaultPos);
  if (afterLeftParse) left = afterLeftParse.call(this, left, startPos, startLoc);
  if (this.type.isAssign) {
    var node = this.startNodeAt(startPos, startLoc);
    node.operator = this.value;
    node.left = this.type === _tokentype.types.eq ? this.toAssignable(left) : left;
    refShorthandDefaultPos.start = 0; // reset because shorthand default was used correctly
    this.checkLVal(left);
    this.next();
    node.right = this.parseMaybeAssign(noIn);
    return this.finishNode(node, "AssignmentExpression");
  } else if (failOnShorthandAssign && refShorthandDefaultPos.start) {
    this.unexpected(refShorthandDefaultPos.start);
  }
  return left;
};

// Parse a ternary conditional (`?:`) operator.

pp.parseMaybeConditional = function (noIn, refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseExprOps(noIn, refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  if (this.eat(_tokentype.types.question)) {
    var node = this.startNodeAt(startPos, startLoc);
    node.test = expr;
    node.consequent = this.parseMaybeAssign();
    this.expect(_tokentype.types.colon);
    node.alternate = this.parseMaybeAssign(noIn);
    return this.finishNode(node, "ConditionalExpression");
  }
  return expr;
};

// Start the precedence parser.

pp.parseExprOps = function (noIn, refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseMaybeUnary(refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  return this.parseExprOp(expr, startPos, startLoc, -1, noIn);
};

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.

pp.parseExprOp = function (left, leftStartPos, leftStartLoc, minPrec, noIn) {
  var prec = this.type.binop;
  if (prec != null && (!noIn || this.type !== _tokentype.types._in)) {
    if (prec > minPrec) {
      var node = this.startNodeAt(leftStartPos, leftStartLoc);
      node.left = left;
      node.operator = this.value;
      var op = this.type;
      this.next();
      var startPos = this.start,
          startLoc = this.startLoc;
      node.right = this.parseExprOp(this.parseMaybeUnary(), startPos, startLoc, prec, noIn);
      this.finishNode(node, op === _tokentype.types.logicalOR || op === _tokentype.types.logicalAND ? "LogicalExpression" : "BinaryExpression");
      return this.parseExprOp(node, leftStartPos, leftStartLoc, minPrec, noIn);
    }
  }
  return left;
};

// Parse unary operators, both prefix and postfix.

pp.parseMaybeUnary = function (refShorthandDefaultPos) {
  if (this.type.prefix) {
    var node = this.startNode(),
        update = this.type === _tokentype.types.incDec;
    node.operator = this.value;
    node.prefix = true;
    this.next();
    node.argument = this.parseMaybeUnary();
    if (refShorthandDefaultPos && refShorthandDefaultPos.start) this.unexpected(refShorthandDefaultPos.start);
    if (update) this.checkLVal(node.argument);else if (this.strict && node.operator === "delete" && node.argument.type === "Identifier") this.raise(node.start, "Deleting local variable in strict mode");
    return this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
  }
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseExprSubscripts(refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  while (this.type.postfix && !this.canInsertSemicolon()) {
    var node = this.startNodeAt(startPos, startLoc);
    node.operator = this.value;
    node.prefix = false;
    node.argument = expr;
    this.checkLVal(expr);
    this.next();
    expr = this.finishNode(node, "UpdateExpression");
  }
  return expr;
};

// Parse call, dot, and `[]`-subscript expressions.

pp.parseExprSubscripts = function (refShorthandDefaultPos) {
  var startPos = this.start,
      startLoc = this.startLoc;
  var expr = this.parseExprAtom(refShorthandDefaultPos);
  if (refShorthandDefaultPos && refShorthandDefaultPos.start) return expr;
  return this.parseSubscripts(expr, startPos, startLoc);
};

pp.parseSubscripts = function (base, startPos, startLoc, noCalls) {
  for (;;) {
    if (this.eat(_tokentype.types.dot)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.property = this.parseIdent(true);
      node.computed = false;
      base = this.finishNode(node, "MemberExpression");
    } else if (this.eat(_tokentype.types.bracketL)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.object = base;
      node.property = this.parseExpression();
      node.computed = true;
      this.expect(_tokentype.types.bracketR);
      base = this.finishNode(node, "MemberExpression");
    } else if (!noCalls && this.eat(_tokentype.types.parenL)) {
      var node = this.startNodeAt(startPos, startLoc);
      node.callee = base;
      node.arguments = this.parseExprList(_tokentype.types.parenR, false);
      base = this.finishNode(node, "CallExpression");
    } else if (this.type === _tokentype.types.backQuote) {
      var node = this.startNodeAt(startPos, startLoc);
      node.tag = base;
      node.quasi = this.parseTemplate();
      base = this.finishNode(node, "TaggedTemplateExpression");
    } else {
      return base;
    }
  }
};

// Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.

pp.parseExprAtom = function (refShorthandDefaultPos) {
  var node = undefined,
      canBeArrow = this.potentialArrowAt == this.start;
  switch (this.type) {
    case _tokentype.types._super:
      if (!this.inFunction) this.raise(this.start, "'super' outside of function or class");
    case _tokentype.types._this:
      var type = this.type === _tokentype.types._this ? "ThisExpression" : "Super";
      node = this.startNode();
      this.next();
      return this.finishNode(node, type);

    case _tokentype.types._yield:
      if (this.inGenerator) this.unexpected();

    case _tokentype.types.name:
      var startPos = this.start,
          startLoc = this.startLoc;
      var id = this.parseIdent(this.type !== _tokentype.types.name);
      if (canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow)) return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id]);
      return id;

    case _tokentype.types.regexp:
      var value = this.value;
      node = this.parseLiteral(value.value);
      node.regex = { pattern: value.pattern, flags: value.flags };
      return node;

    case _tokentype.types.num:case _tokentype.types.string:
      return this.parseLiteral(this.value);

    case _tokentype.types._null:case _tokentype.types._true:case _tokentype.types._false:
      node = this.startNode();
      node.value = this.type === _tokentype.types._null ? null : this.type === _tokentype.types._true;
      node.raw = this.type.keyword;
      this.next();
      return this.finishNode(node, "Literal");

    case _tokentype.types.parenL:
      return this.parseParenAndDistinguishExpression(canBeArrow);

    case _tokentype.types.bracketL:
      node = this.startNode();
      this.next();
      // check whether this is array comprehension or regular array
      if (this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for) {
        return this.parseComprehension(node, false);
      }
      node.elements = this.parseExprList(_tokentype.types.bracketR, true, true, refShorthandDefaultPos);
      return this.finishNode(node, "ArrayExpression");

    case _tokentype.types.braceL:
      return this.parseObj(false, refShorthandDefaultPos);

    case _tokentype.types._function:
      node = this.startNode();
      this.next();
      return this.parseFunction(node, false);

    case _tokentype.types._class:
      return this.parseClass(this.startNode(), false);

    case _tokentype.types._new:
      return this.parseNew();

    case _tokentype.types.backQuote:
      return this.parseTemplate();

    default:
      this.unexpected();
  }
};

pp.parseLiteral = function (value) {
  var node = this.startNode();
  node.value = value;
  node.raw = this.input.slice(this.start, this.end);
  this.next();
  return this.finishNode(node, "Literal");
};

pp.parseParenExpression = function () {
  this.expect(_tokentype.types.parenL);
  var val = this.parseExpression();
  this.expect(_tokentype.types.parenR);
  return val;
};

pp.parseParenAndDistinguishExpression = function (canBeArrow) {
  var startPos = this.start,
      startLoc = this.startLoc,
      val = undefined;
  if (this.options.ecmaVersion >= 6) {
    this.next();

    if (this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for) {
      return this.parseComprehension(this.startNodeAt(startPos, startLoc), true);
    }

    var innerStartPos = this.start,
        innerStartLoc = this.startLoc;
    var exprList = [],
        first = true;
    var refShorthandDefaultPos = { start: 0 },
        spreadStart = undefined,
        innerParenStart = undefined;
    while (this.type !== _tokentype.types.parenR) {
      first ? first = false : this.expect(_tokentype.types.comma);
      if (this.type === _tokentype.types.ellipsis) {
        spreadStart = this.start;
        exprList.push(this.parseParenItem(this.parseRest()));
        break;
      } else {
        if (this.type === _tokentype.types.parenL && !innerParenStart) {
          innerParenStart = this.start;
        }
        exprList.push(this.parseMaybeAssign(false, refShorthandDefaultPos, this.parseParenItem));
      }
    }
    var innerEndPos = this.start,
        innerEndLoc = this.startLoc;
    this.expect(_tokentype.types.parenR);

    if (canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow)) {
      if (innerParenStart) this.unexpected(innerParenStart);
      return this.parseParenArrowList(startPos, startLoc, exprList);
    }

    if (!exprList.length) this.unexpected(this.lastTokStart);
    if (spreadStart) this.unexpected(spreadStart);
    if (refShorthandDefaultPos.start) this.unexpected(refShorthandDefaultPos.start);

    if (exprList.length > 1) {
      val = this.startNodeAt(innerStartPos, innerStartLoc);
      val.expressions = exprList;
      this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
    } else {
      val = exprList[0];
    }
  } else {
    val = this.parseParenExpression();
  }

  if (this.options.preserveParens) {
    var par = this.startNodeAt(startPos, startLoc);
    par.expression = val;
    return this.finishNode(par, "ParenthesizedExpression");
  } else {
    return val;
  }
};

pp.parseParenItem = function (item) {
  return item;
};

pp.parseParenArrowList = function (startPos, startLoc, exprList) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList);
};

// New's precedence is slightly tricky. It must allow its argument
// to be a `[]` or dot subscript expression, but not a call — at
// least, not without wrapping it in parentheses. Thus, it uses the

var empty = [];

pp.parseNew = function () {
  var node = this.startNode();
  var meta = this.parseIdent(true);
  if (this.options.ecmaVersion >= 6 && this.eat(_tokentype.types.dot)) {
    node.meta = meta;
    node.property = this.parseIdent(true);
    if (node.property.name !== "target") this.raise(node.property.start, "The only valid meta property for new is new.target");
    return this.finishNode(node, "MetaProperty");
  }
  var startPos = this.start,
      startLoc = this.startLoc;
  node.callee = this.parseSubscripts(this.parseExprAtom(), startPos, startLoc, true);
  if (this.eat(_tokentype.types.parenL)) node.arguments = this.parseExprList(_tokentype.types.parenR, false);else node.arguments = empty;
  return this.finishNode(node, "NewExpression");
};

// Parse template expression.

pp.parseTemplateElement = function () {
  var elem = this.startNode();
  elem.value = {
    raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, '\n'),
    cooked: this.value
  };
  this.next();
  elem.tail = this.type === _tokentype.types.backQuote;
  return this.finishNode(elem, "TemplateElement");
};

pp.parseTemplate = function () {
  var node = this.startNode();
  this.next();
  node.expressions = [];
  var curElt = this.parseTemplateElement();
  node.quasis = [curElt];
  while (!curElt.tail) {
    this.expect(_tokentype.types.dollarBraceL);
    node.expressions.push(this.parseExpression());
    this.expect(_tokentype.types.braceR);
    node.quasis.push(curElt = this.parseTemplateElement());
  }
  this.next();
  return this.finishNode(node, "TemplateLiteral");
};

// Parse an object literal or binding pattern.

pp.parseObj = function (isPattern, refShorthandDefaultPos) {
  var node = this.startNode(),
      first = true,
      propHash = {};
  node.properties = [];
  this.next();
  while (!this.eat(_tokentype.types.braceR)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (this.afterTrailingComma(_tokentype.types.braceR)) break;
    } else first = false;

    var prop = this.startNode(),
        isGenerator = undefined,
        startPos = undefined,
        startLoc = undefined;
    if (this.options.ecmaVersion >= 6) {
      prop.method = false;
      prop.shorthand = false;
      if (isPattern || refShorthandDefaultPos) {
        startPos = this.start;
        startLoc = this.startLoc;
      }
      if (!isPattern) isGenerator = this.eat(_tokentype.types.star);
    }
    this.parsePropertyName(prop);
    this.parsePropertyValue(prop, isPattern, isGenerator, startPos, startLoc, refShorthandDefaultPos);
    this.checkPropClash(prop, propHash);
    node.properties.push(this.finishNode(prop, "Property"));
  }
  return this.finishNode(node, isPattern ? "ObjectPattern" : "ObjectExpression");
};

pp.parsePropertyValue = function (prop, isPattern, isGenerator, startPos, startLoc, refShorthandDefaultPos) {
  if (this.eat(_tokentype.types.colon)) {
    prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refShorthandDefaultPos);
    prop.kind = "init";
  } else if (this.options.ecmaVersion >= 6 && this.type === _tokentype.types.parenL) {
    if (isPattern) this.unexpected();
    prop.kind = "init";
    prop.method = true;
    prop.value = this.parseMethod(isGenerator);
  } else if (this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type != _tokentype.types.comma && this.type != _tokentype.types.braceR)) {
    if (isGenerator || isPattern) this.unexpected();
    prop.kind = prop.key.name;
    this.parsePropertyName(prop);
    prop.value = this.parseMethod(false);
    var paramCount = prop.kind === "get" ? 0 : 1;
    if (prop.value.params.length !== paramCount) {
      var start = prop.value.start;
      if (prop.kind === "get") this.raise(start, "getter should have no params");else this.raise(start, "setter should have exactly one param");
    }
  } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
    prop.kind = "init";
    if (isPattern) {
      if (this.isKeyword(prop.key.name) || this.strict && (_identifier.reservedWords.strictBind(prop.key.name) || _identifier.reservedWords.strict(prop.key.name)) || !this.options.allowReserved && this.isReservedWord(prop.key.name)) this.raise(prop.key.start, "Binding " + prop.key.name);
      prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
    } else if (this.type === _tokentype.types.eq && refShorthandDefaultPos) {
      if (!refShorthandDefaultPos.start) refShorthandDefaultPos.start = this.start;
      prop.value = this.parseMaybeDefault(startPos, startLoc, prop.key);
    } else {
      prop.value = prop.key;
    }
    prop.shorthand = true;
  } else this.unexpected();
};

pp.parsePropertyName = function (prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(_tokentype.types.bracketL)) {
      prop.computed = true;
      prop.key = this.parseMaybeAssign();
      this.expect(_tokentype.types.bracketR);
      return prop.key;
    } else {
      prop.computed = false;
    }
  }
  return prop.key = this.type === _tokentype.types.num || this.type === _tokentype.types.string ? this.parseExprAtom() : this.parseIdent(true);
};

// Initialize empty function node.

pp.initFunction = function (node) {
  node.id = null;
  if (this.options.ecmaVersion >= 6) {
    node.generator = false;
    node.expression = false;
  }
};

// Parse object or class method.

pp.parseMethod = function (isGenerator) {
  var node = this.startNode();
  this.initFunction(node);
  this.expect(_tokentype.types.parenL);
  node.params = this.parseBindingList(_tokentype.types.parenR, false, false);
  var allowExpressionBody = undefined;
  if (this.options.ecmaVersion >= 6) {
    node.generator = isGenerator;
  }
  this.parseFunctionBody(node, false);
  return this.finishNode(node, "FunctionExpression");
};

// Parse arrow function expression with given parameters.

pp.parseArrowExpression = function (node, params) {
  this.initFunction(node);
  node.params = this.toAssignableList(params, true);
  this.parseFunctionBody(node, true);
  return this.finishNode(node, "ArrowFunctionExpression");
};

// Parse function body and check parameters.

pp.parseFunctionBody = function (node, allowExpression) {
  var isExpression = allowExpression && this.type !== _tokentype.types.braceL;

  if (isExpression) {
    node.body = this.parseMaybeAssign();
    node.expression = true;
  } else {
    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    var oldInFunc = this.inFunction,
        oldInGen = this.inGenerator,
        oldLabels = this.labels;
    this.inFunction = true;this.inGenerator = node.generator;this.labels = [];
    node.body = this.parseBlock(true);
    node.expression = false;
    this.inFunction = oldInFunc;this.inGenerator = oldInGen;this.labels = oldLabels;
  }

  // If this is a strict mode function, verify that argument names
  // are not repeated, and it does not try to bind the words `eval`
  // or `arguments`.
  if (this.strict || !isExpression && node.body.body.length && this.isUseStrict(node.body.body[0])) {
    var nameHash = {},
        oldStrict = this.strict;
    this.strict = true;
    if (node.id) this.checkLVal(node.id, true);
    for (var i = 0; i < node.params.length; i++) {
      this.checkLVal(node.params[i], true, nameHash);
    }this.strict = oldStrict;
  }
};

// Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).

pp.parseExprList = function (close, allowTrailingComma, allowEmpty, refShorthandDefaultPos) {
  var elts = [],
      first = true;
  while (!this.eat(close)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (allowTrailingComma && this.afterTrailingComma(close)) break;
    } else first = false;

    var elt = undefined;
    if (allowEmpty && this.type === _tokentype.types.comma) elt = null;else if (this.type === _tokentype.types.ellipsis) elt = this.parseSpread(refShorthandDefaultPos);else elt = this.parseMaybeAssign(false, refShorthandDefaultPos);
    elts.push(elt);
  }
  return elts;
};

// Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.

pp.parseIdent = function (liberal) {
  var node = this.startNode();
  if (liberal && this.options.allowReserved == "never") liberal = false;
  if (this.type === _tokentype.types.name) {
    if (!liberal && (!this.options.allowReserved && this.isReservedWord(this.value) || this.strict && _identifier.reservedWords.strict(this.value) && (this.options.ecmaVersion >= 6 || this.input.slice(this.start, this.end).indexOf("\\") == -1))) this.raise(this.start, "The keyword '" + this.value + "' is reserved");
    node.name = this.value;
  } else if (liberal && this.type.keyword) {
    node.name = this.type.keyword;
  } else {
    this.unexpected();
  }
  this.next();
  return this.finishNode(node, "Identifier");
};

// Parses yield expression inside generator.

pp.parseYield = function () {
  var node = this.startNode();
  this.next();
  if (this.type == _tokentype.types.semi || this.canInsertSemicolon() || this.type != _tokentype.types.star && !this.type.startsExpr) {
    node.delegate = false;
    node.argument = null;
  } else {
    node.delegate = this.eat(_tokentype.types.star);
    node.argument = this.parseMaybeAssign();
  }
  return this.finishNode(node, "YieldExpression");
};

// Parses array and generator comprehensions.

pp.parseComprehension = function (node, isGenerator) {
  node.blocks = [];
  while (this.type === _tokentype.types._for) {
    var block = this.startNode();
    this.next();
    this.expect(_tokentype.types.parenL);
    block.left = this.parseBindingAtom();
    this.checkLVal(block.left, true);
    this.expectContextual("of");
    block.right = this.parseExpression();
    this.expect(_tokentype.types.parenR);
    node.blocks.push(this.finishNode(block, "ComprehensionBlock"));
  }
  node.filter = this.eat(_tokentype.types._if) ? this.parseParenExpression() : null;
  node.body = this.parseExpression();
  this.expect(isGenerator ? _tokentype.types.parenR : _tokentype.types.bracketR);
  node.generator = isGenerator;
  return this.finishNode(node, "ComprehensionExpression");
};

},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],2:[function(_dereq_,module,exports){
// This is a trick taken from Esprima. It turns out that, on
// non-Chrome browsers, to check whether a string is in a set, a
// predicate containing a big ugly `switch` statement is faster than
// a regular expression, and on Chrome the two are about on par.
// This function uses `eval` (non-lexical) to produce such a
// predicate from a space-separated string of words.
//
// It starts by sorting the words by length.

"use strict";

exports.__esModule = true;
exports.isIdentifierStart = isIdentifierStart;
exports.isIdentifierChar = isIdentifierChar;
function makePredicate(words) {
  words = words.split(" ");
  var f = "",
      cats = [];
  out: for (var i = 0; i < words.length; ++i) {
    for (var j = 0; j < cats.length; ++j) {
      if (cats[j][0].length == words[i].length) {
        cats[j].push(words[i]);
        continue out;
      }
    }cats.push([words[i]]);
  }
  function compareTo(arr) {
    if (arr.length == 1) return f += "return str === " + JSON.stringify(arr[0]) + ";";
    f += "switch(str){";
    for (var i = 0; i < arr.length; ++i) {
      f += "case " + JSON.stringify(arr[i]) + ":";
    }f += "return true}return false;";
  }

  // When there are more than three length categories, an outer
  // switch first dispatches on the lengths, to save on comparisons.

  if (cats.length > 3) {
    cats.sort(function (a, b) {
      return b.length - a.length;
    });
    f += "switch(str.length){";
    for (var i = 0; i < cats.length; ++i) {
      var cat = cats[i];
      f += "case " + cat[0].length + ":";
      compareTo(cat);
    }
    f += "}";

    // Otherwise, simply generate a flat `switch` statement.
  } else {
      compareTo(words);
    }
  return new Function("str", f);
}

// Reserved word lists for various dialects of the language

var reservedWords = {
  3: makePredicate("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile"),
  5: makePredicate("class enum extends super const export import"),
  6: makePredicate("enum await"),
  strict: makePredicate("implements interface let package private protected public static yield"),
  strictBind: makePredicate("eval arguments")
};

exports.reservedWords = reservedWords;
// And the keywords

var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";

var keywords = {
  5: makePredicate(ecma5AndLessKeywords),
  6: makePredicate(ecma5AndLessKeywords + " let const class extends export import yield super")
};

exports.keywords = keywords;
// ## Character categories

// Big ugly regular expressions that match characters in the
// whitespace, identifier, and identifier-start categories. These
// are only applied when a character is found to actually have a
// code point above 128.
// Generated by `tools/generate-identifier-regex.js`.

var nonASCIIidentifierStartChars = "ªµºÀ-ÖØ-öø-ˁˆ-ˑˠ-ˤˬˮͰ-ʹͶͷͺ-ͽͿΆΈ-ΊΌΎ-ΡΣ-ϵϷ-ҁҊ-ԯԱ-Ֆՙա-ևא-תװ-ײؠ-يٮٯٱ-ۓەۥۦۮۯۺ-ۼۿܐܒ-ܯݍ-ޥޱߊ-ߪߴߵߺࠀ-ࠕࠚࠤࠨࡀ-ࡘࢠ-ࢲऄ-हऽॐक़-ॡॱ-ঀঅ-ঌএঐও-নপ-রলশ-হঽৎড়ঢ়য়-ৡৰৱਅ-ਊਏਐਓ-ਨਪ-ਰਲਲ਼ਵਸ਼ਸਹਖ਼-ੜਫ਼ੲ-ੴઅ-ઍએ-ઑઓ-નપ-રલળવ-હઽૐૠૡଅ-ଌଏଐଓ-ନପ-ରଲଳଵ-ହଽଡ଼ଢ଼ୟ-ୡୱஃஅ-ஊஎ-ஐஒ-கஙசஜஞடணதந-பம-ஹௐఅ-ఌఎ-ఐఒ-నప-హఽౘౙౠౡಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹಽೞೠೡೱೲഅ-ഌഎ-ഐഒ-ഺഽൎൠൡൺ-ൿඅ-ඖක-නඳ-රලව-ෆก-ะาำเ-ๆກຂຄງຈຊຍດ-ທນ-ຟມ-ຣລວສຫອ-ະາຳຽເ-ໄໆໜ-ໟༀཀ-ཇཉ-ཬྈ-ྌက-ဪဿၐ-ၕၚ-ၝၡၥၦၮ-ၰၵ-ႁႎႠ-ჅჇჍა-ჺჼ-ቈቊ-ቍቐ-ቖቘቚ-ቝበ-ኈኊ-ኍነ-ኰኲ-ኵኸ-ኾዀዂ-ዅወ-ዖዘ-ጐጒ-ጕጘ-ፚᎀ-ᎏᎠ-Ᏼᐁ-ᙬᙯ-ᙿᚁ-ᚚᚠ-ᛪᛮ-ᛸᜀ-ᜌᜎ-ᜑᜠ-ᜱᝀ-ᝑᝠ-ᝬᝮ-ᝰក-ឳៗៜᠠ-ᡷᢀ-ᢨᢪᢰ-ᣵᤀ-ᤞᥐ-ᥭᥰ-ᥴᦀ-ᦫᧁ-ᧇᨀ-ᨖᨠ-ᩔᪧᬅ-ᬳᭅ-ᭋᮃ-ᮠᮮᮯᮺ-ᯥᰀ-ᰣᱍ-ᱏᱚ-ᱽᳩ-ᳬᳮ-ᳱᳵᳶᴀ-ᶿḀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼⁱⁿₐ-ₜℂℇℊ-ℓℕ℘-ℝℤΩℨK-ℹℼ-ℿⅅ-ⅉⅎⅠ-ↈⰀ-Ⱞⰰ-ⱞⱠ-ⳤⳫ-ⳮⳲⳳⴀ-ⴥⴧⴭⴰ-ⵧⵯⶀ-ⶖⶠ-ⶦⶨ-ⶮⶰ-ⶶⶸ-ⶾⷀ-ⷆⷈ-ⷎⷐ-ⷖⷘ-ⷞ々-〇〡-〩〱-〵〸-〼ぁ-ゖ゛-ゟァ-ヺー-ヿㄅ-ㄭㄱ-ㆎㆠ-ㆺㇰ-ㇿ㐀-䶵一-鿌ꀀ-ꒌꓐ-ꓽꔀ-ꘌꘐ-ꘟꘪꘫꙀ-ꙮꙿ-ꚝꚠ-ꛯꜗ-ꜟꜢ-ꞈꞋ-ꞎꞐ-ꞭꞰꞱꟷ-ꠁꠃ-ꠅꠇ-ꠊꠌ-ꠢꡀ-ꡳꢂ-ꢳꣲ-ꣷꣻꤊ-ꤥꤰ-ꥆꥠ-ꥼꦄ-ꦲꧏꧠ-ꧤꧦ-ꧯꧺ-ꧾꨀ-ꨨꩀ-ꩂꩄ-ꩋꩠ-ꩶꩺꩾ-ꪯꪱꪵꪶꪹ-ꪽꫀꫂꫛ-ꫝꫠ-ꫪꫲ-ꫴꬁ-ꬆꬉ-ꬎꬑ-ꬖꬠ-ꬦꬨ-ꬮꬰ-ꭚꭜ-ꭟꭤꭥꯀ-ꯢ가-힣ힰ-ퟆퟋ-ퟻ豈-舘並-龎ﬀ-ﬆﬓ-ﬗיִײַ-ﬨשׁ-זּטּ-לּמּנּסּףּפּצּ-ﮱﯓ-ﴽﵐ-ﶏﶒ-ﷇﷰ-ﷻﹰ-ﹴﹶ-ﻼＡ-Ｚａ-ｚｦ-ﾾￂ-ￇￊ-ￏￒ-ￗￚ-ￜ";
var nonASCIIidentifierChars = "‌‍·̀-ͯ·҃-֑҇-ׇֽֿׁׂׅׄؐ-ًؚ-٩ٰۖ-ۜ۟-۪ۤۧۨ-ۭ۰-۹ܑܰ-݊ަ-ް߀-߉߫-߳ࠖ-࠙ࠛ-ࠣࠥ-ࠧࠩ-࡙࠭-࡛ࣤ-ःऺ-़ा-ॏ॑-ॗॢॣ०-९ঁ-ঃ়া-ৄেৈো-্ৗৢৣ০-৯ਁ-ਃ਼ਾ-ੂੇੈੋ-੍ੑ੦-ੱੵઁ-ઃ઼ા-ૅે-ૉો-્ૢૣ૦-૯ଁ-ଃ଼ା-ୄେୈୋ-୍ୖୗୢୣ୦-୯ஂா-ூெ-ைொ-்ௗ௦-௯ఀ-ఃా-ౄె-ైొ-్ౕౖౢౣ౦-౯ಁ-ಃ಼ಾ-ೄೆ-ೈೊ-್ೕೖೢೣ೦-೯ഁ-ഃാ-ൄെ-ൈൊ-്ൗൢൣ൦-൯ංඃ්ා-ුූෘ-ෟ෦-෯ෲෳัิ-ฺ็-๎๐-๙ັິ-ູົຼ່-ໍ໐-໙༘༙༠-༩༹༵༷༾༿ཱ-྄྆྇ྍ-ྗྙ-ྼ࿆ါ-ှ၀-၉ၖ-ၙၞ-ၠၢ-ၤၧ-ၭၱ-ၴႂ-ႍႏ-ႝ፝-፟፩-፱ᜒ-᜔ᜲ-᜴ᝒᝓᝲᝳ឴-៓៝០-៩᠋-᠍᠐-᠙ᢩᤠ-ᤫᤰ-᤻᥆-᥏ᦰ-ᧀᧈᧉ᧐-᧚ᨗ-ᨛᩕ-ᩞ᩠-᩿᩼-᪉᪐-᪙᪰-᪽ᬀ-ᬄ᬴-᭄᭐-᭙᭫-᭳ᮀ-ᮂᮡ-ᮭ᮰-᮹᯦-᯳ᰤ-᰷᱀-᱉᱐-᱙᳐-᳔᳒-᳨᳭ᳲ-᳴᳸᳹᷀-᷵᷼-᷿‿⁀⁔⃐-⃥⃜⃡-⃰⳯-⵿⳱ⷠ-〪ⷿ-゙゚〯꘠-꘩꙯ꙴ-꙽ꚟ꛰꛱ꠂ꠆ꠋꠣ-ꠧꢀꢁꢴ-꣄꣐-꣙꣠-꣱꤀-꤉ꤦ-꤭ꥇ-꥓ꦀ-ꦃ꦳-꧀꧐-꧙ꧥ꧰-꧹ꨩ-ꨶꩃꩌꩍ꩐-꩙ꩻ-ꩽꪰꪲ-ꪴꪷꪸꪾ꪿꫁ꫫ-ꫯꫵ꫶ꯣ-ꯪ꯬꯭꯰-꯹ﬞ︀-️︠-︭︳︴﹍-﹏０-９＿";

var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");

nonASCIIidentifierStartChars = nonASCIIidentifierChars = null;

// These are a run-length and offset encoded representation of the
// >0xffff code points that are a valid part of identifiers. The
// offset starts at 0x10000, and each pair of numbers represents an
// offset to the next range, and then a size of the range. They were
// generated by tools/generate-identifier-regex.js
var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 17, 26, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 99, 39, 9, 51, 157, 310, 10, 21, 11, 7, 153, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 98, 21, 11, 25, 71, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 26, 45, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 955, 52, 76, 44, 33, 24, 27, 35, 42, 34, 4, 0, 13, 47, 15, 3, 22, 0, 38, 17, 2, 24, 133, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 32, 4, 287, 47, 21, 1, 2, 0, 185, 46, 82, 47, 21, 0, 60, 42, 502, 63, 32, 0, 449, 56, 1288, 920, 104, 110, 2962, 1070, 13266, 568, 8, 30, 114, 29, 19, 47, 17, 3, 32, 20, 6, 18, 881, 68, 12, 0, 67, 12, 16481, 1, 3071, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 4149, 196, 1340, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42710, 42, 4148, 12, 221, 16355, 541];
var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 1306, 2, 54, 14, 32, 9, 16, 3, 46, 10, 54, 9, 7, 2, 37, 13, 2, 9, 52, 0, 13, 2, 49, 13, 16, 9, 83, 11, 168, 11, 6, 9, 8, 2, 57, 0, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 316, 19, 13, 9, 214, 6, 3, 8, 112, 16, 16, 9, 82, 12, 9, 9, 535, 9, 20855, 9, 135, 4, 60, 6, 26, 9, 1016, 45, 17, 3, 19723, 1, 5319, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 4305, 6, 792618, 239];

// This has a complexity linear to the value of the code. The
// assumption is that looking up astral identifier characters is
// rare.
function isInAstralSet(code, set) {
  var pos = 0x10000;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) return false;
    pos += set[i + 1];
    if (pos >= code) return true;
  }
}

// Test whether a given character code starts an identifier.

function isIdentifierStart(code, astral) {
  if (code < 65) return code === 36;
  if (code < 91) return true;
  if (code < 97) return code === 95;
  if (code < 123) return true;
  if (code <= 0xffff) return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));
  if (astral === false) return false;
  return isInAstralSet(code, astralIdentifierStartCodes);
}

// Test whether a given character is part of an identifier.

function isIdentifierChar(code, astral) {
  if (code < 48) return code === 36;
  if (code < 58) return true;
  if (code < 65) return false;
  if (code < 91) return true;
  if (code < 97) return code === 95;
  if (code < 123) return true;
  if (code <= 0xffff) return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));
  if (astral === false) return false;
  return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
}

},{}],3:[function(_dereq_,module,exports){
// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke, Ingvar Stepanyan, and
// various contributors and released under an MIT license.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js

"use strict";

exports.__esModule = true;
exports.parse = parse;
exports.parseExpressionAt = parseExpressionAt;
exports.tokenizer = tokenizer;

var _state = _dereq_("./state");

var _options = _dereq_("./options");

_dereq_("./parseutil");

_dereq_("./statement");

_dereq_("./lval");

_dereq_("./expression");

_dereq_("./location");

exports.Parser = _state.Parser;
exports.plugins = _state.plugins;
exports.defaultOptions = _options.defaultOptions;

var _locutil = _dereq_("./locutil");

exports.Position = _locutil.Position;
exports.SourceLocation = _locutil.SourceLocation;
exports.getLineInfo = _locutil.getLineInfo;

var _node = _dereq_("./node");

exports.Node = _node.Node;

var _tokentype = _dereq_("./tokentype");

exports.TokenType = _tokentype.TokenType;
exports.tokTypes = _tokentype.types;

var _tokencontext = _dereq_("./tokencontext");

exports.TokContext = _tokencontext.TokContext;
exports.tokContexts = _tokencontext.types;

var _identifier = _dereq_("./identifier");

exports.isIdentifierChar = _identifier.isIdentifierChar;
exports.isIdentifierStart = _identifier.isIdentifierStart;

var _tokenize = _dereq_("./tokenize");

exports.Token = _tokenize.Token;

var _whitespace = _dereq_("./whitespace");

exports.isNewLine = _whitespace.isNewLine;
exports.lineBreak = _whitespace.lineBreak;
exports.lineBreakG = _whitespace.lineBreakG;
var version = "2.2.0";

exports.version = version;
// The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and
// returns an abstract syntax tree as specified by [Mozilla parser
// API][api].
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API

function parse(input, options) {
  return new _state.Parser(options, input).parse();
}

// This function tries to parse a single expression at a given
// offset in a string. Useful for parsing mixed-language formats
// that embed JavaScript expressions.

function parseExpressionAt(input, pos, options) {
  var p = new _state.Parser(options, input, pos);
  p.nextToken();
  return p.parseExpression();
}

// Acorn is organized as a tokenizer and a recursive-descent parser.
// The `tokenize` export provides an interface to the tokenizer.

function tokenizer(input, options) {
  return new _state.Parser(options, input);
}

},{"./expression":1,"./identifier":2,"./location":4,"./locutil":5,"./lval":6,"./node":7,"./options":8,"./parseutil":9,"./state":10,"./statement":11,"./tokencontext":12,"./tokenize":13,"./tokentype":14,"./whitespace":16}],4:[function(_dereq_,module,exports){
"use strict";

var _state = _dereq_("./state");

var _locutil = _dereq_("./locutil");

var pp = _state.Parser.prototype;

// This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.

pp.raise = function (pos, message) {
  var loc = _locutil.getLineInfo(this.input, pos);
  message += " (" + loc.line + ":" + loc.column + ")";
  var err = new SyntaxError(message);
  err.pos = pos;err.loc = loc;err.raisedAt = this.pos;
  throw err;
};

pp.curPosition = function () {
  if (this.options.locations) {
    return new _locutil.Position(this.curLine, this.pos - this.lineStart);
  }
};

},{"./locutil":5,"./state":10}],5:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.getLineInfo = getLineInfo;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _whitespace = _dereq_("./whitespace");

// These are used when `options.locations` is on, for the
// `startLoc` and `endLoc` properties.

var Position = (function () {
  function Position(line, col) {
    _classCallCheck(this, Position);

    this.line = line;
    this.column = col;
  }

  Position.prototype.offset = function offset(n) {
    return new Position(this.line, this.column + n);
  };

  return Position;
})();

exports.Position = Position;

var SourceLocation = function SourceLocation(p, start, end) {
  _classCallCheck(this, SourceLocation);

  this.start = start;
  this.end = end;
  if (p.sourceFile !== null) this.source = p.sourceFile;
}

// The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.

;

exports.SourceLocation = SourceLocation;

function getLineInfo(input, offset) {
  for (var line = 1, cur = 0;;) {
    _whitespace.lineBreakG.lastIndex = cur;
    var match = _whitespace.lineBreakG.exec(input);
    if (match && match.index < offset) {
      ++line;
      cur = match.index + match[0].length;
    } else {
      return new Position(line, offset - cur);
    }
  }
}

},{"./whitespace":16}],6:[function(_dereq_,module,exports){
"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _identifier = _dereq_("./identifier");

var _util = _dereq_("./util");

var pp = _state.Parser.prototype;

// Convert existing expression atom to assignable pattern
// if possible.

pp.toAssignable = function (node, isBinding) {
  if (this.options.ecmaVersion >= 6 && node) {
    switch (node.type) {
      case "Identifier":
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
        break;

      case "ObjectExpression":
        node.type = "ObjectPattern";
        for (var i = 0; i < node.properties.length; i++) {
          var prop = node.properties[i];
          if (prop.kind !== "init") this.raise(prop.key.start, "Object pattern can't contain getter or setter");
          this.toAssignable(prop.value, isBinding);
        }
        break;

      case "ArrayExpression":
        node.type = "ArrayPattern";
        this.toAssignableList(node.elements, isBinding);
        break;

      case "AssignmentExpression":
        if (node.operator === "=") {
          node.type = "AssignmentPattern";
          delete node.operator;
        } else {
          this.raise(node.left.end, "Only '=' operator can be used for specifying default value.");
        }
        break;

      case "ParenthesizedExpression":
        node.expression = this.toAssignable(node.expression, isBinding);
        break;

      case "MemberExpression":
        if (!isBinding) break;

      default:
        this.raise(node.start, "Assigning to rvalue");
    }
  }
  return node;
};

// Convert list of expression atoms to binding list.

pp.toAssignableList = function (exprList, isBinding) {
  var end = exprList.length;
  if (end) {
    var last = exprList[end - 1];
    if (last && last.type == "RestElement") {
      --end;
    } else if (last && last.type == "SpreadElement") {
      last.type = "RestElement";
      var arg = last.argument;
      this.toAssignable(arg, isBinding);
      if (arg.type !== "Identifier" && arg.type !== "MemberExpression" && arg.type !== "ArrayPattern") this.unexpected(arg.start);
      --end;
    }
  }
  for (var i = 0; i < end; i++) {
    var elt = exprList[i];
    if (elt) this.toAssignable(elt, isBinding);
  }
  return exprList;
};

// Parses spread element.

pp.parseSpread = function (refShorthandDefaultPos) {
  var node = this.startNode();
  this.next();
  node.argument = this.parseMaybeAssign(refShorthandDefaultPos);
  return this.finishNode(node, "SpreadElement");
};

pp.parseRest = function () {
  var node = this.startNode();
  this.next();
  node.argument = this.type === _tokentype.types.name || this.type === _tokentype.types.bracketL ? this.parseBindingAtom() : this.unexpected();
  return this.finishNode(node, "RestElement");
};

// Parses lvalue (assignable) atom.

pp.parseBindingAtom = function () {
  if (this.options.ecmaVersion < 6) return this.parseIdent();
  switch (this.type) {
    case _tokentype.types.name:
      return this.parseIdent();

    case _tokentype.types.bracketL:
      var node = this.startNode();
      this.next();
      node.elements = this.parseBindingList(_tokentype.types.bracketR, true, true);
      return this.finishNode(node, "ArrayPattern");

    case _tokentype.types.braceL:
      return this.parseObj(true);

    default:
      this.unexpected();
  }
};

pp.parseBindingList = function (close, allowEmpty, allowTrailingComma) {
  var elts = [],
      first = true;
  while (!this.eat(close)) {
    if (first) first = false;else this.expect(_tokentype.types.comma);
    if (allowEmpty && this.type === _tokentype.types.comma) {
      elts.push(null);
    } else if (allowTrailingComma && this.afterTrailingComma(close)) {
      break;
    } else if (this.type === _tokentype.types.ellipsis) {
      var rest = this.parseRest();
      this.parseBindingListItem(rest);
      elts.push(rest);
      this.expect(close);
      break;
    } else {
      var elem = this.parseMaybeDefault(this.start, this.startLoc);
      this.parseBindingListItem(elem);
      elts.push(elem);
    }
  }
  return elts;
};

pp.parseBindingListItem = function (param) {
  return param;
};

// Parses assignment pattern around given atom if possible.

pp.parseMaybeDefault = function (startPos, startLoc, left) {
  left = left || this.parseBindingAtom();
  if (!this.eat(_tokentype.types.eq)) return left;
  var node = this.startNodeAt(startPos, startLoc);
  node.left = left;
  node.right = this.parseMaybeAssign();
  return this.finishNode(node, "AssignmentPattern");
};

// Verify that a node is an lval — something that can be assigned
// to.

pp.checkLVal = function (expr, isBinding, checkClashes) {
  switch (expr.type) {
    case "Identifier":
      if (this.strict && (_identifier.reservedWords.strictBind(expr.name) || _identifier.reservedWords.strict(expr.name))) this.raise(expr.start, (isBinding ? "Binding " : "Assigning to ") + expr.name + " in strict mode");
      if (checkClashes) {
        if (_util.has(checkClashes, expr.name)) this.raise(expr.start, "Argument name clash in strict mode");
        checkClashes[expr.name] = true;
      }
      break;

    case "MemberExpression":
      if (isBinding) this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " member expression");
      break;

    case "ObjectPattern":
      for (var i = 0; i < expr.properties.length; i++) {
        this.checkLVal(expr.properties[i].value, isBinding, checkClashes);
      }break;

    case "ArrayPattern":
      for (var i = 0; i < expr.elements.length; i++) {
        var elem = expr.elements[i];
        if (elem) this.checkLVal(elem, isBinding, checkClashes);
      }
      break;

    case "AssignmentPattern":
      this.checkLVal(expr.left, isBinding, checkClashes);
      break;

    case "RestElement":
      this.checkLVal(expr.argument, isBinding, checkClashes);
      break;

    case "ParenthesizedExpression":
      this.checkLVal(expr.expression, isBinding, checkClashes);
      break;

    default:
      this.raise(expr.start, (isBinding ? "Binding" : "Assigning to") + " rvalue");
  }
};

},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],7:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _state = _dereq_("./state");

var _locutil = _dereq_("./locutil");

var Node = function Node(parser, pos, loc) {
  _classCallCheck(this, Node);

  this.type = "";
  this.start = pos;
  this.end = 0;
  if (parser.options.locations) this.loc = new _locutil.SourceLocation(parser, loc);
  if (parser.options.directSourceFile) this.sourceFile = parser.options.directSourceFile;
  if (parser.options.ranges) this.range = [pos, 0];
}

// Start an AST node, attaching a start offset.

;

exports.Node = Node;
var pp = _state.Parser.prototype;

pp.startNode = function () {
  return new Node(this, this.start, this.startLoc);
};

pp.startNodeAt = function (pos, loc) {
  return new Node(this, pos, loc);
};

// Finish an AST node, adding `type` and `end` properties.

function finishNodeAt(node, type, pos, loc) {
  node.type = type;
  node.end = pos;
  if (this.options.locations) node.loc.end = loc;
  if (this.options.ranges) node.range[1] = pos;
  return node;
}

pp.finishNode = function (node, type) {
  return finishNodeAt.call(this, node, type, this.lastTokEnd, this.lastTokEndLoc);
};

// Finish node at given position

pp.finishNodeAt = function (node, type, pos, loc) {
  return finishNodeAt.call(this, node, type, pos, loc);
};

},{"./locutil":5,"./state":10}],8:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.getOptions = getOptions;

var _util = _dereq_("./util");

var _locutil = _dereq_("./locutil");

// A second optional argument can be given to further configure
// the parser process. These options are recognized:

var defaultOptions = {
  // `ecmaVersion` indicates the ECMAScript version to parse. Must
  // be either 3, or 5, or 6. This influences support for strict
  // mode, the set of reserved words, support for getters and
  // setters and other features.
  ecmaVersion: 5,
  // Source type ("script" or "module") for different semantics
  sourceType: "script",
  // `onInsertedSemicolon` can be a callback that will be called
  // when a semicolon is automatically inserted. It will be passed
  // th position of the comma as an offset, and if `locations` is
  // enabled, it is given the location as a `{line, column}` object
  // as second argument.
  onInsertedSemicolon: null,
  // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
  // trailing commas.
  onTrailingComma: null,
  // By default, reserved words are not enforced. Disable
  // `allowReserved` to enforce them. When this option has the
  // value "never", reserved words and keywords can also not be
  // used as property names.
  allowReserved: true,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: false,
  // When enabled, import/export statements are not constrained to
  // appearing at the top of the program.
  allowImportExportEverywhere: false,
  // When enabled, hashbang directive in the beginning of file
  // is allowed and treated as a line comment.
  allowHashBang: false,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: false,
  // A function can be passed as `onToken` option, which will
  // cause Acorn to call that function with object in the same
  // format as tokenize() returns. Note that you are not
  // allowed to call the parser from the callback—that will
  // corrupt its internal state.
  onToken: null,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  onComment: null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: false,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: null,
  // When enabled, parenthesized expressions are represented by
  // (non-standard) ParenthesizedExpression nodes
  preserveParens: false,
  plugins: {}
};

exports.defaultOptions = defaultOptions;
// Interpret and default an options object

function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions) {
    options[opt] = opts && _util.has(opts, opt) ? opts[opt] : defaultOptions[opt];
  }if (_util.isArray(options.onToken)) {
    (function () {
      var tokens = options.onToken;
      options.onToken = function (token) {
        return tokens.push(token);
      };
    })();
  }
  if (_util.isArray(options.onComment)) options.onComment = pushComment(options, options.onComment);

  return options;
}

function pushComment(options, array) {
  return function (block, text, start, end, startLoc, endLoc) {
    var comment = {
      type: block ? 'Block' : 'Line',
      value: text,
      start: start,
      end: end
    };
    if (options.locations) comment.loc = new _locutil.SourceLocation(this, startLoc, endLoc);
    if (options.ranges) comment.range = [start, end];
    array.push(comment);
  };
}

},{"./locutil":5,"./util":15}],9:[function(_dereq_,module,exports){
"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _whitespace = _dereq_("./whitespace");

var pp = _state.Parser.prototype;

// ## Parser utilities

// Test whether a statement node is the string literal `"use strict"`.

pp.isUseStrict = function (stmt) {
  return this.options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && stmt.expression.raw.slice(1, -1) === "use strict";
};

// Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.

pp.eat = function (type) {
  if (this.type === type) {
    this.next();
    return true;
  } else {
    return false;
  }
};

// Tests whether parsed token is a contextual keyword.

pp.isContextual = function (name) {
  return this.type === _tokentype.types.name && this.value === name;
};

// Consumes contextual keyword if possible.

pp.eatContextual = function (name) {
  return this.value === name && this.eat(_tokentype.types.name);
};

// Asserts that following token is given contextual keyword.

pp.expectContextual = function (name) {
  if (!this.eatContextual(name)) this.unexpected();
};

// Test whether a semicolon can be inserted at the current position.

pp.canInsertSemicolon = function () {
  return this.type === _tokentype.types.eof || this.type === _tokentype.types.braceR || _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
};

pp.insertSemicolon = function () {
  if (this.canInsertSemicolon()) {
    if (this.options.onInsertedSemicolon) this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
    return true;
  }
};

// Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.

pp.semicolon = function () {
  if (!this.eat(_tokentype.types.semi) && !this.insertSemicolon()) this.unexpected();
};

pp.afterTrailingComma = function (tokType) {
  if (this.type == tokType) {
    if (this.options.onTrailingComma) this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
    this.next();
    return true;
  }
};

// Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.

pp.expect = function (type) {
  this.eat(type) || this.unexpected();
};

// Raise an unexpected token error.

pp.unexpected = function (pos) {
  this.raise(pos != null ? pos : this.start, "Unexpected token");
};

},{"./state":10,"./tokentype":14,"./whitespace":16}],10:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _identifier = _dereq_("./identifier");

var _tokentype = _dereq_("./tokentype");

var _whitespace = _dereq_("./whitespace");

var _options = _dereq_("./options");

// Registered plugins
var plugins = {};

exports.plugins = plugins;

var Parser = (function () {
  function Parser(options, input, startPos) {
    _classCallCheck(this, Parser);

    this.options = _options.getOptions(options);
    this.sourceFile = this.options.sourceFile;
    this.isKeyword = _identifier.keywords[this.options.ecmaVersion >= 6 ? 6 : 5];
    this.isReservedWord = _identifier.reservedWords[this.options.ecmaVersion];
    this.input = String(input);

    // Used to signal to callers of `readWord1` whether the word
    // contained any escape sequences. This is needed because words with
    // escape sequences must not be interpreted as keywords.
    this.containsEsc = false;

    // Load plugins
    this.loadPlugins(this.options.plugins);

    // Set up token state

    // The current position of the tokenizer in the input.
    if (startPos) {
      this.pos = startPos;
      this.lineStart = Math.max(0, this.input.lastIndexOf("\n", startPos));
      this.curLine = this.input.slice(0, this.lineStart).split(_whitespace.lineBreak).length;
    } else {
      this.pos = this.lineStart = 0;
      this.curLine = 1;
    }

    // Properties of the current token:
    // Its type
    this.type = _tokentype.types.eof;
    // For tokens that include more information than their type, the value
    this.value = null;
    // Its start and end offset
    this.start = this.end = this.pos;
    // And, if locations are used, the {line, column} object
    // corresponding to those offsets
    this.startLoc = this.endLoc = this.curPosition();

    // Position information for the previous token
    this.lastTokEndLoc = this.lastTokStartLoc = null;
    this.lastTokStart = this.lastTokEnd = this.pos;

    // The context stack is used to superficially track syntactic
    // context to predict whether a regular expression is allowed in a
    // given position.
    this.context = this.initialContext();
    this.exprAllowed = true;

    // Figure out if it's a module code.
    this.strict = this.inModule = this.options.sourceType === "module";

    // Used to signify the start of a potential arrow function
    this.potentialArrowAt = -1;

    // Flags to track whether we are in a function, a generator.
    this.inFunction = this.inGenerator = false;
    // Labels in scope.
    this.labels = [];

    // If enabled, skip leading hashbang line.
    if (this.pos === 0 && this.options.allowHashBang && this.input.slice(0, 2) === '#!') this.skipLineComment(2);
  }

  Parser.prototype.extend = function extend(name, f) {
    this[name] = f(this[name]);
  };

  Parser.prototype.loadPlugins = function loadPlugins(pluginConfigs) {
    for (var _name in pluginConfigs) {
      var plugin = plugins[_name];
      if (!plugin) throw new Error("Plugin '" + _name + "' not found");
      plugin(this, pluginConfigs[_name]);
    }
  };

  Parser.prototype.parse = function parse() {
    var node = this.options.program || this.startNode();
    this.nextToken();
    return this.parseTopLevel(node);
  };

  return Parser;
})();

exports.Parser = Parser;

},{"./identifier":2,"./options":8,"./tokentype":14,"./whitespace":16}],11:[function(_dereq_,module,exports){
"use strict";

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _whitespace = _dereq_("./whitespace");

var pp = _state.Parser.prototype;

// ### Statement parsing

// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.

pp.parseTopLevel = function (node) {
  var first = true;
  if (!node.body) node.body = [];
  while (this.type !== _tokentype.types.eof) {
    var stmt = this.parseStatement(true, true);
    node.body.push(stmt);
    if (first) {
      if (this.isUseStrict(stmt)) this.setStrict(true);
      first = false;
    }
  }
  this.next();
  if (this.options.ecmaVersion >= 6) {
    node.sourceType = this.options.sourceType;
  }
  return this.finishNode(node, "Program");
};

var loopLabel = { kind: "loop" },
    switchLabel = { kind: "switch" };

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.

pp.parseStatement = function (declaration, topLevel) {
  var starttype = this.type,
      node = this.startNode();

  // Most types of statements are recognized by the keyword they
  // start with. Many are trivial to parse, some require a bit of
  // complexity.

  switch (starttype) {
    case _tokentype.types._break:case _tokentype.types._continue:
      return this.parseBreakContinueStatement(node, starttype.keyword);
    case _tokentype.types._debugger:
      return this.parseDebuggerStatement(node);
    case _tokentype.types._do:
      return this.parseDoStatement(node);
    case _tokentype.types._for:
      return this.parseForStatement(node);
    case _tokentype.types._function:
      if (!declaration && this.options.ecmaVersion >= 6) this.unexpected();
      return this.parseFunctionStatement(node);
    case _tokentype.types._class:
      if (!declaration) this.unexpected();
      return this.parseClass(node, true);
    case _tokentype.types._if:
      return this.parseIfStatement(node);
    case _tokentype.types._return:
      return this.parseReturnStatement(node);
    case _tokentype.types._switch:
      return this.parseSwitchStatement(node);
    case _tokentype.types._throw:
      return this.parseThrowStatement(node);
    case _tokentype.types._try:
      return this.parseTryStatement(node);
    case _tokentype.types._let:case _tokentype.types._const:
      if (!declaration) this.unexpected(); // NOTE: falls through to _var
    case _tokentype.types._var:
      return this.parseVarStatement(node, starttype);
    case _tokentype.types._while:
      return this.parseWhileStatement(node);
    case _tokentype.types._with:
      return this.parseWithStatement(node);
    case _tokentype.types.braceL:
      return this.parseBlock();
    case _tokentype.types.semi:
      return this.parseEmptyStatement(node);
    case _tokentype.types._export:
    case _tokentype.types._import:
      if (!this.options.allowImportExportEverywhere) {
        if (!topLevel) this.raise(this.start, "'import' and 'export' may only appear at the top level");
        if (!this.inModule) this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
      }
      return starttype === _tokentype.types._import ? this.parseImport(node) : this.parseExport(node);

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    default:
      var maybeName = this.value,
          expr = this.parseExpression();
      if (starttype === _tokentype.types.name && expr.type === "Identifier" && this.eat(_tokentype.types.colon)) return this.parseLabeledStatement(node, maybeName, expr);else return this.parseExpressionStatement(node, expr);
  }
};

pp.parseBreakContinueStatement = function (node, keyword) {
  var isBreak = keyword == "break";
  this.next();
  if (this.eat(_tokentype.types.semi) || this.insertSemicolon()) node.label = null;else if (this.type !== _tokentype.types.name) this.unexpected();else {
    node.label = this.parseIdent();
    this.semicolon();
  }

  // Verify that there is an actual destination to break or
  // continue to.
  for (var i = 0; i < this.labels.length; ++i) {
    var lab = this.labels[i];
    if (node.label == null || lab.name === node.label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
      if (node.label && isBreak) break;
    }
  }
  if (i === this.labels.length) this.raise(node.start, "Unsyntactic " + keyword);
  return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");
};

pp.parseDebuggerStatement = function (node) {
  this.next();
  this.semicolon();
  return this.finishNode(node, "DebuggerStatement");
};

pp.parseDoStatement = function (node) {
  this.next();
  this.labels.push(loopLabel);
  node.body = this.parseStatement(false);
  this.labels.pop();
  this.expect(_tokentype.types._while);
  node.test = this.parseParenExpression();
  if (this.options.ecmaVersion >= 6) this.eat(_tokentype.types.semi);else this.semicolon();
  return this.finishNode(node, "DoWhileStatement");
};

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.

pp.parseForStatement = function (node) {
  this.next();
  this.labels.push(loopLabel);
  this.expect(_tokentype.types.parenL);
  if (this.type === _tokentype.types.semi) return this.parseFor(node, null);
  if (this.type === _tokentype.types._var || this.type === _tokentype.types._let || this.type === _tokentype.types._const) {
    var _init = this.startNode(),
        varKind = this.type;
    this.next();
    this.parseVar(_init, true, varKind);
    this.finishNode(_init, "VariableDeclaration");
    if ((this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && _init.declarations.length === 1 && !(varKind !== _tokentype.types._var && _init.declarations[0].init)) return this.parseForIn(node, _init);
    return this.parseFor(node, _init);
  }
  var refShorthandDefaultPos = { start: 0 };
  var init = this.parseExpression(true, refShorthandDefaultPos);
  if (this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) {
    this.toAssignable(init);
    this.checkLVal(init);
    return this.parseForIn(node, init);
  } else if (refShorthandDefaultPos.start) {
    this.unexpected(refShorthandDefaultPos.start);
  }
  return this.parseFor(node, init);
};

pp.parseFunctionStatement = function (node) {
  this.next();
  return this.parseFunction(node, true);
};

pp.parseIfStatement = function (node) {
  this.next();
  node.test = this.parseParenExpression();
  node.consequent = this.parseStatement(false);
  node.alternate = this.eat(_tokentype.types._else) ? this.parseStatement(false) : null;
  return this.finishNode(node, "IfStatement");
};

pp.parseReturnStatement = function (node) {
  if (!this.inFunction && !this.options.allowReturnOutsideFunction) this.raise(this.start, "'return' outside of function");
  this.next();

  // In `return` (and `break`/`continue`), the keywords with
  // optional arguments, we eagerly look for a semicolon or the
  // possibility to insert one.

  if (this.eat(_tokentype.types.semi) || this.insertSemicolon()) node.argument = null;else {
    node.argument = this.parseExpression();this.semicolon();
  }
  return this.finishNode(node, "ReturnStatement");
};

pp.parseSwitchStatement = function (node) {
  this.next();
  node.discriminant = this.parseParenExpression();
  node.cases = [];
  this.expect(_tokentype.types.braceL);
  this.labels.push(switchLabel);

  // Statements under must be grouped (by label) in SwitchCase
  // nodes. `cur` is used to keep the node that we are currently
  // adding statements to.

  for (var cur, sawDefault = false; this.type != _tokentype.types.braceR;) {
    if (this.type === _tokentype.types._case || this.type === _tokentype.types._default) {
      var isCase = this.type === _tokentype.types._case;
      if (cur) this.finishNode(cur, "SwitchCase");
      node.cases.push(cur = this.startNode());
      cur.consequent = [];
      this.next();
      if (isCase) {
        cur.test = this.parseExpression();
      } else {
        if (sawDefault) this.raise(this.lastTokStart, "Multiple default clauses");
        sawDefault = true;
        cur.test = null;
      }
      this.expect(_tokentype.types.colon);
    } else {
      if (!cur) this.unexpected();
      cur.consequent.push(this.parseStatement(true));
    }
  }
  if (cur) this.finishNode(cur, "SwitchCase");
  this.next(); // Closing brace
  this.labels.pop();
  return this.finishNode(node, "SwitchStatement");
};

pp.parseThrowStatement = function (node) {
  this.next();
  if (_whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) this.raise(this.lastTokEnd, "Illegal newline after throw");
  node.argument = this.parseExpression();
  this.semicolon();
  return this.finishNode(node, "ThrowStatement");
};

// Reused empty array added for node fields that are always empty.

var empty = [];

pp.parseTryStatement = function (node) {
  this.next();
  node.block = this.parseBlock();
  node.handler = null;
  if (this.type === _tokentype.types._catch) {
    var clause = this.startNode();
    this.next();
    this.expect(_tokentype.types.parenL);
    clause.param = this.parseBindingAtom();
    this.checkLVal(clause.param, true);
    this.expect(_tokentype.types.parenR);
    clause.guard = null;
    clause.body = this.parseBlock();
    node.handler = this.finishNode(clause, "CatchClause");
  }
  node.guardedHandlers = empty;
  node.finalizer = this.eat(_tokentype.types._finally) ? this.parseBlock() : null;
  if (!node.handler && !node.finalizer) this.raise(node.start, "Missing catch or finally clause");
  return this.finishNode(node, "TryStatement");
};

pp.parseVarStatement = function (node, kind) {
  this.next();
  this.parseVar(node, false, kind);
  this.semicolon();
  return this.finishNode(node, "VariableDeclaration");
};

pp.parseWhileStatement = function (node) {
  this.next();
  node.test = this.parseParenExpression();
  this.labels.push(loopLabel);
  node.body = this.parseStatement(false);
  this.labels.pop();
  return this.finishNode(node, "WhileStatement");
};

pp.parseWithStatement = function (node) {
  if (this.strict) this.raise(this.start, "'with' in strict mode");
  this.next();
  node.object = this.parseParenExpression();
  node.body = this.parseStatement(false);
  return this.finishNode(node, "WithStatement");
};

pp.parseEmptyStatement = function (node) {
  this.next();
  return this.finishNode(node, "EmptyStatement");
};

pp.parseLabeledStatement = function (node, maybeName, expr) {
  for (var i = 0; i < this.labels.length; ++i) {
    if (this.labels[i].name === maybeName) this.raise(expr.start, "Label '" + maybeName + "' is already declared");
  }var kind = this.type.isLoop ? "loop" : this.type === _tokentype.types._switch ? "switch" : null;
  for (var i = this.labels.length - 1; i >= 0; i--) {
    var label = this.labels[i];
    if (label.statementStart == node.start) {
      label.statementStart = this.start;
      label.kind = kind;
    } else break;
  }
  this.labels.push({ name: maybeName, kind: kind, statementStart: this.start });
  node.body = this.parseStatement(true);
  this.labels.pop();
  node.label = expr;
  return this.finishNode(node, "LabeledStatement");
};

pp.parseExpressionStatement = function (node, expr) {
  node.expression = expr;
  this.semicolon();
  return this.finishNode(node, "ExpressionStatement");
};

// Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).

pp.parseBlock = function (allowStrict) {
  var node = this.startNode(),
      first = true,
      oldStrict = undefined;
  node.body = [];
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    var stmt = this.parseStatement(true);
    node.body.push(stmt);
    if (first && allowStrict && this.isUseStrict(stmt)) {
      oldStrict = this.strict;
      this.setStrict(this.strict = true);
    }
    first = false;
  }
  if (oldStrict === false) this.setStrict(false);
  return this.finishNode(node, "BlockStatement");
};

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

pp.parseFor = function (node, init) {
  node.init = init;
  this.expect(_tokentype.types.semi);
  node.test = this.type === _tokentype.types.semi ? null : this.parseExpression();
  this.expect(_tokentype.types.semi);
  node.update = this.type === _tokentype.types.parenR ? null : this.parseExpression();
  this.expect(_tokentype.types.parenR);
  node.body = this.parseStatement(false);
  this.labels.pop();
  return this.finishNode(node, "ForStatement");
};

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

pp.parseForIn = function (node, init) {
  var type = this.type === _tokentype.types._in ? "ForInStatement" : "ForOfStatement";
  this.next();
  node.left = init;
  node.right = this.parseExpression();
  this.expect(_tokentype.types.parenR);
  node.body = this.parseStatement(false);
  this.labels.pop();
  return this.finishNode(node, type);
};

// Parse a list of variable declarations.

pp.parseVar = function (node, isFor, kind) {
  node.declarations = [];
  node.kind = kind.keyword;
  for (;;) {
    var decl = this.startNode();
    this.parseVarId(decl);
    if (this.eat(_tokentype.types.eq)) {
      decl.init = this.parseMaybeAssign(isFor);
    } else if (kind === _tokentype.types._const && !(this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
      this.unexpected();
    } else if (decl.id.type != "Identifier" && !(isFor && (this.type === _tokentype.types._in || this.isContextual("of")))) {
      this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
    } else {
      decl.init = null;
    }
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
    if (!this.eat(_tokentype.types.comma)) break;
  }
  return node;
};

pp.parseVarId = function (decl) {
  decl.id = this.parseBindingAtom();
  this.checkLVal(decl.id, true);
};

// Parse a function declaration or literal (depending on the
// `isStatement` parameter).

pp.parseFunction = function (node, isStatement, allowExpressionBody) {
  this.initFunction(node);
  if (this.options.ecmaVersion >= 6) node.generator = this.eat(_tokentype.types.star);
  if (isStatement || this.type === _tokentype.types.name) node.id = this.parseIdent();
  this.parseFunctionParams(node);
  this.parseFunctionBody(node, allowExpressionBody);
  return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
};

pp.parseFunctionParams = function (node) {
  this.expect(_tokentype.types.parenL);
  node.params = this.parseBindingList(_tokentype.types.parenR, false, false);
};

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

pp.parseClass = function (node, isStatement) {
  this.next();
  this.parseClassId(node, isStatement);
  this.parseClassSuper(node);
  var classBody = this.startNode();
  var hadConstructor = false;
  classBody.body = [];
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    if (this.eat(_tokentype.types.semi)) continue;
    var method = this.startNode();
    var isGenerator = this.eat(_tokentype.types.star);
    var isMaybeStatic = this.type === _tokentype.types.name && this.value === "static";
    this.parsePropertyName(method);
    method["static"] = isMaybeStatic && this.type !== _tokentype.types.parenL;
    if (method["static"]) {
      if (isGenerator) this.unexpected();
      isGenerator = this.eat(_tokentype.types.star);
      this.parsePropertyName(method);
    }
    method.kind = "method";
    var isGetSet = false;
    if (!method.computed) {
      var key = method.key;

      if (!isGenerator && key.type === "Identifier" && this.type !== _tokentype.types.parenL && (key.name === "get" || key.name === "set")) {
        isGetSet = true;
        method.kind = key.name;
        key = this.parsePropertyName(method);
      }
      if (!method["static"] && (key.type === "Identifier" && key.name === "constructor" || key.type === "Literal" && key.value === "constructor")) {
        if (hadConstructor) this.raise(key.start, "Duplicate constructor in the same class");
        if (isGetSet) this.raise(key.start, "Constructor can't have get/set modifier");
        if (isGenerator) this.raise(key.start, "Constructor can't be a generator");
        method.kind = "constructor";
        hadConstructor = true;
      }
    }
    this.parseClassMethod(classBody, method, isGenerator);
    if (isGetSet) {
      var paramCount = method.kind === "get" ? 0 : 1;
      if (method.value.params.length !== paramCount) {
        var start = method.value.start;
        if (method.kind === "get") this.raise(start, "getter should have no params");else this.raise(start, "setter should have exactly one param");
      }
    }
  }
  node.body = this.finishNode(classBody, "ClassBody");
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
};

pp.parseClassMethod = function (classBody, method, isGenerator) {
  method.value = this.parseMethod(isGenerator);
  classBody.body.push(this.finishNode(method, "MethodDefinition"));
};

pp.parseClassId = function (node, isStatement) {
  node.id = this.type === _tokentype.types.name ? this.parseIdent() : isStatement ? this.unexpected() : null;
};

pp.parseClassSuper = function (node) {
  node.superClass = this.eat(_tokentype.types._extends) ? this.parseExprSubscripts() : null;
};

// Parses module export declaration.

pp.parseExport = function (node) {
  this.next();
  // export * from '...'
  if (this.eat(_tokentype.types.star)) {
    this.expectContextual("from");
    node.source = this.type === _tokentype.types.string ? this.parseExprAtom() : this.unexpected();
    this.semicolon();
    return this.finishNode(node, "ExportAllDeclaration");
  }
  if (this.eat(_tokentype.types._default)) {
    // export default ...
    var expr = this.parseMaybeAssign();
    var needsSemi = true;
    if (expr.type == "FunctionExpression" || expr.type == "ClassExpression") {
      needsSemi = false;
      if (expr.id) {
        expr.type = expr.type == "FunctionExpression" ? "FunctionDeclaration" : "ClassDeclaration";
      }
    }
    node.declaration = expr;
    if (needsSemi) this.semicolon();
    return this.finishNode(node, "ExportDefaultDeclaration");
  }
  // export var|const|let|function|class ...
  if (this.shouldParseExportStatement()) {
    node.declaration = this.parseStatement(true);
    node.specifiers = [];
    node.source = null;
  } else {
    // export { x, y as z } [from '...']
    node.declaration = null;
    node.specifiers = this.parseExportSpecifiers();
    if (this.eatContextual("from")) {
      node.source = this.type === _tokentype.types.string ? this.parseExprAtom() : this.unexpected();
    } else {
      node.source = null;
    }
    this.semicolon();
  }
  return this.finishNode(node, "ExportNamedDeclaration");
};

pp.shouldParseExportStatement = function () {
  return this.type.keyword;
};

// Parses a comma-separated list of module exports.

pp.parseExportSpecifiers = function () {
  var nodes = [],
      first = true;
  // export { x, y as z } [from '...']
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (this.afterTrailingComma(_tokentype.types.braceR)) break;
    } else first = false;

    var node = this.startNode();
    node.local = this.parseIdent(this.type === _tokentype.types._default);
    node.exported = this.eatContextual("as") ? this.parseIdent(true) : node.local;
    nodes.push(this.finishNode(node, "ExportSpecifier"));
  }
  return nodes;
};

// Parses import declaration.

pp.parseImport = function (node) {
  this.next();
  // import '...'
  if (this.type === _tokentype.types.string) {
    node.specifiers = empty;
    node.source = this.parseExprAtom();
  } else {
    node.specifiers = this.parseImportSpecifiers();
    this.expectContextual("from");
    node.source = this.type === _tokentype.types.string ? this.parseExprAtom() : this.unexpected();
  }
  this.semicolon();
  return this.finishNode(node, "ImportDeclaration");
};

// Parses a comma-separated list of module imports.

pp.parseImportSpecifiers = function () {
  var nodes = [],
      first = true;
  if (this.type === _tokentype.types.name) {
    // import defaultObj, { x, y as z } from '...'
    var node = this.startNode();
    node.local = this.parseIdent();
    this.checkLVal(node.local, true);
    nodes.push(this.finishNode(node, "ImportDefaultSpecifier"));
    if (!this.eat(_tokentype.types.comma)) return nodes;
  }
  if (this.type === _tokentype.types.star) {
    var node = this.startNode();
    this.next();
    this.expectContextual("as");
    node.local = this.parseIdent();
    this.checkLVal(node.local, true);
    nodes.push(this.finishNode(node, "ImportNamespaceSpecifier"));
    return nodes;
  }
  this.expect(_tokentype.types.braceL);
  while (!this.eat(_tokentype.types.braceR)) {
    if (!first) {
      this.expect(_tokentype.types.comma);
      if (this.afterTrailingComma(_tokentype.types.braceR)) break;
    } else first = false;

    var node = this.startNode();
    node.imported = this.parseIdent(true);
    node.local = this.eatContextual("as") ? this.parseIdent() : node.imported;
    this.checkLVal(node.local, true);
    nodes.push(this.finishNode(node, "ImportSpecifier"));
  }
  return nodes;
};

},{"./state":10,"./tokentype":14,"./whitespace":16}],12:[function(_dereq_,module,exports){
// The algorithm used to determine whether a regexp can appear at a
// given point in the program is loosely based on sweet.js' approach.
// See https://github.com/mozilla/sweet.js/wiki/design

"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _state = _dereq_("./state");

var _tokentype = _dereq_("./tokentype");

var _whitespace = _dereq_("./whitespace");

var TokContext = function TokContext(token, isExpr, preserveSpace, override) {
  _classCallCheck(this, TokContext);

  this.token = token;
  this.isExpr = !!isExpr;
  this.preserveSpace = !!preserveSpace;
  this.override = override;
};

exports.TokContext = TokContext;
var types = {
  b_stat: new TokContext("{", false),
  b_expr: new TokContext("{", true),
  b_tmpl: new TokContext("${", true),
  p_stat: new TokContext("(", false),
  p_expr: new TokContext("(", true),
  q_tmpl: new TokContext("`", true, true, function (p) {
    return p.readTmplToken();
  }),
  f_expr: new TokContext("function", true)
};

exports.types = types;
var pp = _state.Parser.prototype;

pp.initialContext = function () {
  return [types.b_stat];
};

pp.braceIsBlock = function (prevType) {
  if (prevType === _tokentype.types.colon) {
    var _parent = this.curContext();
    if (_parent === types.b_stat || _parent === types.b_expr) return !_parent.isExpr;
  }
  if (prevType === _tokentype.types._return) return _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  if (prevType === _tokentype.types._else || prevType === _tokentype.types.semi || prevType === _tokentype.types.eof || prevType === _tokentype.types.parenR) return true;
  if (prevType == _tokentype.types.braceL) return this.curContext() === types.b_stat;
  return !this.exprAllowed;
};

pp.updateContext = function (prevType) {
  var update = undefined,
      type = this.type;
  if (type.keyword && prevType == _tokentype.types.dot) this.exprAllowed = false;else if (update = type.updateContext) update.call(this, prevType);else this.exprAllowed = type.beforeExpr;
};

// Token-specific context update code

_tokentype.types.parenR.updateContext = _tokentype.types.braceR.updateContext = function () {
  if (this.context.length == 1) {
    this.exprAllowed = true;
    return;
  }
  var out = this.context.pop();
  if (out === types.b_stat && this.curContext() === types.f_expr) {
    this.context.pop();
    this.exprAllowed = false;
  } else if (out === types.b_tmpl) {
    this.exprAllowed = true;
  } else {
    this.exprAllowed = !out.isExpr;
  }
};

_tokentype.types.braceL.updateContext = function (prevType) {
  this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
  this.exprAllowed = true;
};

_tokentype.types.dollarBraceL.updateContext = function () {
  this.context.push(types.b_tmpl);
  this.exprAllowed = true;
};

_tokentype.types.parenL.updateContext = function (prevType) {
  var statementParens = prevType === _tokentype.types._if || prevType === _tokentype.types._for || prevType === _tokentype.types._with || prevType === _tokentype.types._while;
  this.context.push(statementParens ? types.p_stat : types.p_expr);
  this.exprAllowed = true;
};

_tokentype.types.incDec.updateContext = function () {
  // tokExprAllowed stays unchanged
};

_tokentype.types._function.updateContext = function () {
  if (this.curContext() !== types.b_stat) this.context.push(types.f_expr);
  this.exprAllowed = false;
};

_tokentype.types.backQuote.updateContext = function () {
  if (this.curContext() === types.q_tmpl) this.context.pop();else this.context.push(types.q_tmpl);
  this.exprAllowed = false;
};

},{"./state":10,"./tokentype":14,"./whitespace":16}],13:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _identifier = _dereq_("./identifier");

var _tokentype = _dereq_("./tokentype");

var _state = _dereq_("./state");

var _locutil = _dereq_("./locutil");

var _whitespace = _dereq_("./whitespace");

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.

var Token = function Token(p) {
  _classCallCheck(this, Token);

  this.type = p.type;
  this.value = p.value;
  this.start = p.start;
  this.end = p.end;
  if (p.options.locations) this.loc = new _locutil.SourceLocation(p, p.startLoc, p.endLoc);
  if (p.options.ranges) this.range = [p.start, p.end];
}

// ## Tokenizer

;

exports.Token = Token;
var pp = _state.Parser.prototype;

// Are we running under Rhino?
var isRhino = typeof Packages == "object" && Object.prototype.toString.call(Packages) == "[object JavaPackage]";

// Move to the next token

pp.next = function () {
  if (this.options.onToken) this.options.onToken(new Token(this));

  this.lastTokEnd = this.end;
  this.lastTokStart = this.start;
  this.lastTokEndLoc = this.endLoc;
  this.lastTokStartLoc = this.startLoc;
  this.nextToken();
};

pp.getToken = function () {
  this.next();
  return new Token(this);
};

// If we're in an ES6 environment, make parsers iterable
if (typeof Symbol !== "undefined") pp[Symbol.iterator] = function () {
  var self = this;
  return { next: function next() {
      var token = self.getToken();
      return {
        done: token.type === _tokentype.types.eof,
        value: token
      };
    } };
};

// Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).

pp.setStrict = function (strict) {
  this.strict = strict;
  if (this.type !== _tokentype.types.num && this.type !== _tokentype.types.string) return;
  this.pos = this.start;
  if (this.options.locations) {
    while (this.pos < this.lineStart) {
      this.lineStart = this.input.lastIndexOf("\n", this.lineStart - 2) + 1;
      --this.curLine;
    }
  }
  this.nextToken();
};

pp.curContext = function () {
  return this.context[this.context.length - 1];
};

// Read a single token, updating the parser object's token-related
// properties.

pp.nextToken = function () {
  var curContext = this.curContext();
  if (!curContext || !curContext.preserveSpace) this.skipSpace();

  this.start = this.pos;
  if (this.options.locations) this.startLoc = this.curPosition();
  if (this.pos >= this.input.length) return this.finishToken(_tokentype.types.eof);

  if (curContext.override) return curContext.override(this);else this.readToken(this.fullCharCodeAtPos());
};

pp.readToken = function (code) {
  // Identifier or keyword. '\uXXXX' sequences are allowed in
  // identifiers, so '\' also dispatches to that.
  if (_identifier.isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92 /* '\' */) return this.readWord();

  return this.getTokenFromCode(code);
};

pp.fullCharCodeAtPos = function () {
  var code = this.input.charCodeAt(this.pos);
  if (code <= 0xd7ff || code >= 0xe000) return code;
  var next = this.input.charCodeAt(this.pos + 1);
  return (code << 10) + next - 0x35fdc00;
};

pp.skipBlockComment = function () {
  var startLoc = this.options.onComment && this.curPosition();
  var start = this.pos,
      end = this.input.indexOf("*/", this.pos += 2);
  if (end === -1) this.raise(this.pos - 2, "Unterminated comment");
  this.pos = end + 2;
  if (this.options.locations) {
    _whitespace.lineBreakG.lastIndex = start;
    var match = undefined;
    while ((match = _whitespace.lineBreakG.exec(this.input)) && match.index < this.pos) {
      ++this.curLine;
      this.lineStart = match.index + match[0].length;
    }
  }
  if (this.options.onComment) this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos, startLoc, this.curPosition());
};

pp.skipLineComment = function (startSkip) {
  var start = this.pos;
  var startLoc = this.options.onComment && this.curPosition();
  var ch = this.input.charCodeAt(this.pos += startSkip);
  while (this.pos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {
    ++this.pos;
    ch = this.input.charCodeAt(this.pos);
  }
  if (this.options.onComment) this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos, startLoc, this.curPosition());
};

// Called at the start of the parse and after every token. Skips
// whitespace and comments, and.

pp.skipSpace = function () {
  loop: while (this.pos < this.input.length) {
    var ch = this.input.charCodeAt(this.pos);
    switch (ch) {
      case 32:case 160:
        // ' '
        ++this.pos;
        break;
      case 13:
        if (this.input.charCodeAt(this.pos + 1) === 10) {
          ++this.pos;
        }
      case 10:case 8232:case 8233:
        ++this.pos;
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }
        break;
      case 47:
        // '/'
        switch (this.input.charCodeAt(this.pos + 1)) {
          case 42:
            // '*'
            this.skipBlockComment();
            break;
          case 47:
            this.skipLineComment(2);
            break;
          default:
            break loop;
        }
        break;
      default:
        if (ch > 8 && ch < 14 || ch >= 5760 && _whitespace.nonASCIIwhitespace.test(String.fromCharCode(ch))) {
          ++this.pos;
        } else {
          break loop;
        }
    }
  }
};

// Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.

pp.finishToken = function (type, val) {
  this.end = this.pos;
  if (this.options.locations) this.endLoc = this.curPosition();
  var prevType = this.type;
  this.type = type;
  this.value = val;

  this.updateContext(prevType);
};

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
pp.readToken_dot = function () {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next >= 48 && next <= 57) return this.readNumber(true);
  var next2 = this.input.charCodeAt(this.pos + 2);
  if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
    // 46 = dot '.'
    this.pos += 3;
    return this.finishToken(_tokentype.types.ellipsis);
  } else {
    ++this.pos;
    return this.finishToken(_tokentype.types.dot);
  }
};

pp.readToken_slash = function () {
  // '/'
  var next = this.input.charCodeAt(this.pos + 1);
  if (this.exprAllowed) {
    ++this.pos;return this.readRegexp();
  }
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(_tokentype.types.slash, 1);
};

pp.readToken_mult_modulo = function (code) {
  // '%*'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(code === 42 ? _tokentype.types.star : _tokentype.types.modulo, 1);
};

pp.readToken_pipe_amp = function (code) {
  // '|&'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) return this.finishOp(code === 124 ? _tokentype.types.logicalOR : _tokentype.types.logicalAND, 2);
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(code === 124 ? _tokentype.types.bitwiseOR : _tokentype.types.bitwiseAND, 1);
};

pp.readToken_caret = function () {
  // '^'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(_tokentype.types.bitwiseXOR, 1);
};

pp.readToken_plus_min = function (code) {
  // '+-'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (next == 45 && this.input.charCodeAt(this.pos + 2) == 62 && _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd, this.pos))) {
      // A `-->` line comment
      this.skipLineComment(3);
      this.skipSpace();
      return this.nextToken();
    }
    return this.finishOp(_tokentype.types.incDec, 2);
  }
  if (next === 61) return this.finishOp(_tokentype.types.assign, 2);
  return this.finishOp(_tokentype.types.plusMin, 1);
};

pp.readToken_lt_gt = function (code) {
  // '<>'
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  if (next === code) {
    size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
    if (this.input.charCodeAt(this.pos + size) === 61) return this.finishOp(_tokentype.types.assign, size + 1);
    return this.finishOp(_tokentype.types.bitShift, size);
  }
  if (next == 33 && code == 60 && this.input.charCodeAt(this.pos + 2) == 45 && this.input.charCodeAt(this.pos + 3) == 45) {
    if (this.inModule) this.unexpected();
    // `<!--`, an XML-style comment that should be interpreted as a line comment
    this.skipLineComment(4);
    this.skipSpace();
    return this.nextToken();
  }
  if (next === 61) size = this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2;
  return this.finishOp(_tokentype.types.relational, size);
};

pp.readToken_eq_excl = function (code) {
  // '=!'
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) return this.finishOp(_tokentype.types.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
  if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
    // '=>'
    this.pos += 2;
    return this.finishToken(_tokentype.types.arrow);
  }
  return this.finishOp(code === 61 ? _tokentype.types.eq : _tokentype.types.prefix, 1);
};

pp.getTokenFromCode = function (code) {
  switch (code) {
    // The interpretation of a dot depends on whether it is followed
    // by a digit or another two dots.
    case 46:
      // '.'
      return this.readToken_dot();

    // Punctuation tokens.
    case 40:
      ++this.pos;return this.finishToken(_tokentype.types.parenL);
    case 41:
      ++this.pos;return this.finishToken(_tokentype.types.parenR);
    case 59:
      ++this.pos;return this.finishToken(_tokentype.types.semi);
    case 44:
      ++this.pos;return this.finishToken(_tokentype.types.comma);
    case 91:
      ++this.pos;return this.finishToken(_tokentype.types.bracketL);
    case 93:
      ++this.pos;return this.finishToken(_tokentype.types.bracketR);
    case 123:
      ++this.pos;return this.finishToken(_tokentype.types.braceL);
    case 125:
      ++this.pos;return this.finishToken(_tokentype.types.braceR);
    case 58:
      ++this.pos;return this.finishToken(_tokentype.types.colon);
    case 63:
      ++this.pos;return this.finishToken(_tokentype.types.question);

    case 96:
      // '`'
      if (this.options.ecmaVersion < 6) break;
      ++this.pos;
      return this.finishToken(_tokentype.types.backQuote);

    case 48:
      // '0'
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 120 || next === 88) return this.readRadixNumber(16); // '0x', '0X' - hex number
      if (this.options.ecmaVersion >= 6) {
        if (next === 111 || next === 79) return this.readRadixNumber(8); // '0o', '0O' - octal number
        if (next === 98 || next === 66) return this.readRadixNumber(2); // '0b', '0B' - binary number
      }
    // Anything else beginning with a digit is an integer, octal
    // number, or float.
    case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57:
      // 1-9
      return this.readNumber(false);

    // Quotes produce strings.
    case 34:case 39:
      // '"', "'"
      return this.readString(code);

    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.

    case 47:
      // '/'
      return this.readToken_slash();

    case 37:case 42:
      // '%*'
      return this.readToken_mult_modulo(code);

    case 124:case 38:
      // '|&'
      return this.readToken_pipe_amp(code);

    case 94:
      // '^'
      return this.readToken_caret();

    case 43:case 45:
      // '+-'
      return this.readToken_plus_min(code);

    case 60:case 62:
      // '<>'
      return this.readToken_lt_gt(code);

    case 61:case 33:
      // '=!'
      return this.readToken_eq_excl(code);

    case 126:
      // '~'
      return this.finishOp(_tokentype.types.prefix, 1);
  }

  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};

pp.finishOp = function (type, size) {
  var str = this.input.slice(this.pos, this.pos + size);
  this.pos += size;
  return this.finishToken(type, str);
};

// Parse a regular expression. Some context-awareness is necessary,
// since a '/' inside a '[]' set does not end the expression.

function tryCreateRegexp(src, flags, throwErrorAt) {
  try {
    return new RegExp(src, flags);
  } catch (e) {
    if (throwErrorAt !== undefined) {
      if (e instanceof SyntaxError) this.raise(throwErrorAt, "Error parsing regular expression: " + e.message);
      this.raise(e);
    }
  }
}

var regexpUnicodeSupport = !!tryCreateRegexp("￿", "u");

pp.readRegexp = function () {
  var _this = this;

  var escaped = undefined,
      inClass = undefined,
      start = this.pos;
  for (;;) {
    if (this.pos >= this.input.length) this.raise(start, "Unterminated regular expression");
    var ch = this.input.charAt(this.pos);
    if (_whitespace.lineBreak.test(ch)) this.raise(start, "Unterminated regular expression");
    if (!escaped) {
      if (ch === "[") inClass = true;else if (ch === "]" && inClass) inClass = false;else if (ch === "/" && !inClass) break;
      escaped = ch === "\\";
    } else escaped = false;
    ++this.pos;
  }
  var content = this.input.slice(start, this.pos);
  ++this.pos;
  // Need to use `readWord1` because '\uXXXX' sequences are allowed
  // here (don't ask).
  var mods = this.readWord1();
  var tmp = content;
  if (mods) {
    var validFlags = /^[gmsiy]*$/;
    if (this.options.ecmaVersion >= 6) validFlags = /^[gmsiyu]*$/;
    if (!validFlags.test(mods)) this.raise(start, "Invalid regular expression flag");
    if (mods.indexOf('u') >= 0 && !regexpUnicodeSupport) {
      // Replace each astral symbol and every Unicode escape sequence that
      // possibly represents an astral symbol or a paired surrogate with a
      // single ASCII symbol to avoid throwing on regular expressions that
      // are only valid in combination with the `/u` flag.
      // Note: replacing with the ASCII symbol `x` might cause false
      // negatives in unlikely scenarios. For example, `[\u{61}-b]` is a
      // perfectly valid pattern that is equivalent to `[a-b]`, but it would
      // be replaced by `[x-b]` which throws an error.
      tmp = tmp.replace(/\\u\{([0-9a-fA-F]+)\}/g, function (match, code, offset) {
        code = Number("0x" + code);
        if (code > 0x10FFFF) _this.raise(start + offset + 3, "Code point out of bounds");
        return "x";
      });
      tmp = tmp.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "x");
    }
  }
  // Detect invalid regular expressions.
  var value = null;
  // Rhino's regular expression parser is flaky and throws uncatchable exceptions,
  // so don't do detection if we are running under Rhino
  if (!isRhino) {
    tryCreateRegexp(tmp, undefined, start);
    // Get a regular expression object for this pattern-flag pair, or `null` in
    // case the current environment doesn't support the flags it uses.
    value = tryCreateRegexp(content, mods);
  }
  return this.finishToken(_tokentype.types.regexp, { pattern: content, flags: mods, value: value });
};

// Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.

pp.readInt = function (radix, len) {
  var start = this.pos,
      total = 0;
  for (var i = 0, e = len == null ? Infinity : len; i < e; ++i) {
    var code = this.input.charCodeAt(this.pos),
        val = undefined;
    if (code >= 97) val = code - 97 + 10; // a
    else if (code >= 65) val = code - 65 + 10; // A
      else if (code >= 48 && code <= 57) val = code - 48; // 0-9
        else val = Infinity;
    if (val >= radix) break;
    ++this.pos;
    total = total * radix + val;
  }
  if (this.pos === start || len != null && this.pos - start !== len) return null;

  return total;
};

pp.readRadixNumber = function (radix) {
  this.pos += 2; // 0x
  var val = this.readInt(radix);
  if (val == null) this.raise(this.start + 2, "Expected number in radix " + radix);
  if (_identifier.isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");
  return this.finishToken(_tokentype.types.num, val);
};

// Read an integer, octal integer, or floating-point number.

pp.readNumber = function (startsWithDot) {
  var start = this.pos,
      isFloat = false,
      octal = this.input.charCodeAt(this.pos) === 48;
  if (!startsWithDot && this.readInt(10) === null) this.raise(start, "Invalid number");
  var next = this.input.charCodeAt(this.pos);
  if (next === 46) {
    // '.'
    ++this.pos;
    this.readInt(10);
    isFloat = true;
    next = this.input.charCodeAt(this.pos);
  }
  if (next === 69 || next === 101) {
    // 'eE'
    next = this.input.charCodeAt(++this.pos);
    if (next === 43 || next === 45) ++this.pos; // '+-'
    if (this.readInt(10) === null) this.raise(start, "Invalid number");
    isFloat = true;
  }
  if (_identifier.isIdentifierStart(this.fullCharCodeAtPos())) this.raise(this.pos, "Identifier directly after number");

  var str = this.input.slice(start, this.pos),
      val = undefined;
  if (isFloat) val = parseFloat(str);else if (!octal || str.length === 1) val = parseInt(str, 10);else if (/[89]/.test(str) || this.strict) this.raise(start, "Invalid number");else val = parseInt(str, 8);
  return this.finishToken(_tokentype.types.num, val);
};

// Read a string value, interpreting backslash-escapes.

pp.readCodePoint = function () {
  var ch = this.input.charCodeAt(this.pos),
      code = undefined;

  if (ch === 123) {
    if (this.options.ecmaVersion < 6) this.unexpected();
    var codePos = ++this.pos;
    code = this.readHexChar(this.input.indexOf('}', this.pos) - this.pos);
    ++this.pos;
    if (code > 0x10FFFF) this.raise(codePos, "Code point out of bounds");
  } else {
    code = this.readHexChar(4);
  }
  return code;
};

function codePointToString(code) {
  // UTF-16 Decoding
  if (code <= 0xFFFF) return String.fromCharCode(code);
  code -= 0x10000;
  return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00);
}

pp.readString = function (quote) {
  var out = "",
      chunkStart = ++this.pos;
  for (;;) {
    if (this.pos >= this.input.length) this.raise(this.start, "Unterminated string constant");
    var ch = this.input.charCodeAt(this.pos);
    if (ch === quote) break;
    if (ch === 92) {
      // '\'
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(false);
      chunkStart = this.pos;
    } else {
      if (_whitespace.isNewLine(ch)) this.raise(this.start, "Unterminated string constant");
      ++this.pos;
    }
  }
  out += this.input.slice(chunkStart, this.pos++);
  return this.finishToken(_tokentype.types.string, out);
};

// Reads template string tokens.

pp.readTmplToken = function () {
  var out = "",
      chunkStart = this.pos;
  for (;;) {
    if (this.pos >= this.input.length) this.raise(this.start, "Unterminated template");
    var ch = this.input.charCodeAt(this.pos);
    if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
      // '`', '${'
      if (this.pos === this.start && this.type === _tokentype.types.template) {
        if (ch === 36) {
          this.pos += 2;
          return this.finishToken(_tokentype.types.dollarBraceL);
        } else {
          ++this.pos;
          return this.finishToken(_tokentype.types.backQuote);
        }
      }
      out += this.input.slice(chunkStart, this.pos);
      return this.finishToken(_tokentype.types.template, out);
    }
    if (ch === 92) {
      // '\'
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(true);
      chunkStart = this.pos;
    } else if (_whitespace.isNewLine(ch)) {
      out += this.input.slice(chunkStart, this.pos);
      ++this.pos;
      switch (ch) {
        case 13:
          if (this.input.charCodeAt(this.pos) === 10) ++this.pos;
        case 10:
          out += "\n";
          break;
        default:
          out += String.fromCharCode(ch);
          break;
      }
      if (this.options.locations) {
        ++this.curLine;
        this.lineStart = this.pos;
      }
      chunkStart = this.pos;
    } else {
      ++this.pos;
    }
  }
};

// Used to read escaped characters

pp.readEscapedChar = function (inTemplate) {
  var ch = this.input.charCodeAt(++this.pos);
  ++this.pos;
  switch (ch) {
    case 110:
      return "\n"; // 'n' -> '\n'
    case 114:
      return "\r"; // 'r' -> '\r'
    case 120:
      return String.fromCharCode(this.readHexChar(2)); // 'x'
    case 117:
      return codePointToString(this.readCodePoint()); // 'u'
    case 116:
      return "\t"; // 't' -> '\t'
    case 98:
      return "\b"; // 'b' -> '\b'
    case 118:
      return "\u000b"; // 'v' -> '\u000b'
    case 102:
      return "\f"; // 'f' -> '\f'
    case 13:
      if (this.input.charCodeAt(this.pos) === 10) ++this.pos; // '\r\n'
    case 10:
      // ' \n'
      if (this.options.locations) {
        this.lineStart = this.pos;++this.curLine;
      }
      return "";
    default:
      if (ch >= 48 && ch <= 55) {
        var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
        var octal = parseInt(octalStr, 8);
        if (octal > 255) {
          octalStr = octalStr.slice(0, -1);
          octal = parseInt(octalStr, 8);
        }
        if (octal > 0 && (this.strict || inTemplate)) {
          this.raise(this.pos - 2, "Octal literal in strict mode");
        }
        this.pos += octalStr.length - 1;
        return String.fromCharCode(octal);
      }
      return String.fromCharCode(ch);
  }
};

// Used to read character escape sequences ('\x', '\u', '\U').

pp.readHexChar = function (len) {
  var codePos = this.pos;
  var n = this.readInt(16, len);
  if (n === null) this.raise(codePos, "Bad character escape sequence");
  return n;
};

// Read an identifier, and return it as a string. Sets `this.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.

pp.readWord1 = function () {
  this.containsEsc = false;
  var word = "",
      first = true,
      chunkStart = this.pos;
  var astral = this.options.ecmaVersion >= 6;
  while (this.pos < this.input.length) {
    var ch = this.fullCharCodeAtPos();
    if (_identifier.isIdentifierChar(ch, astral)) {
      this.pos += ch <= 0xffff ? 1 : 2;
    } else if (ch === 92) {
      // "\"
      this.containsEsc = true;
      word += this.input.slice(chunkStart, this.pos);
      var escStart = this.pos;
      if (this.input.charCodeAt(++this.pos) != 117) // "u"
        this.raise(this.pos, "Expecting Unicode escape sequence \\uXXXX");
      ++this.pos;
      var esc = this.readCodePoint();
      if (!(first ? _identifier.isIdentifierStart : _identifier.isIdentifierChar)(esc, astral)) this.raise(escStart, "Invalid Unicode escape");
      word += codePointToString(esc);
      chunkStart = this.pos;
    } else {
      break;
    }
    first = false;
  }
  return word + this.input.slice(chunkStart, this.pos);
};

// Read an identifier or keyword token. Will check for reserved
// words when necessary.

pp.readWord = function () {
  var word = this.readWord1();
  var type = _tokentype.types.name;
  if ((this.options.ecmaVersion >= 6 || !this.containsEsc) && this.isKeyword(word)) type = _tokentype.keywords[word];
  return this.finishToken(type, word);
};

},{"./identifier":2,"./locutil":5,"./state":10,"./tokentype":14,"./whitespace":16}],14:[function(_dereq_,module,exports){
// ## Token types

// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.

// All token type variables start with an underscore, to make them
// easy to recognize.

// The `beforeExpr` property is used to disambiguate between regular
// expressions and divisions. It is set on all token types that can
// be followed by an expression (thus, a slash after them would be a
// regular expression).
//
// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.

"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var TokenType = function TokenType(label) {
  var conf = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  _classCallCheck(this, TokenType);

  this.label = label;
  this.keyword = conf.keyword;
  this.beforeExpr = !!conf.beforeExpr;
  this.startsExpr = !!conf.startsExpr;
  this.isLoop = !!conf.isLoop;
  this.isAssign = !!conf.isAssign;
  this.prefix = !!conf.prefix;
  this.postfix = !!conf.postfix;
  this.binop = conf.binop || null;
  this.updateContext = null;
};

exports.TokenType = TokenType;

function binop(name, prec) {
  return new TokenType(name, { beforeExpr: true, binop: prec });
}
var beforeExpr = { beforeExpr: true },
    startsExpr = { startsExpr: true };

var types = {
  num: new TokenType("num", startsExpr),
  regexp: new TokenType("regexp", startsExpr),
  string: new TokenType("string", startsExpr),
  name: new TokenType("name", startsExpr),
  eof: new TokenType("eof"),

  // Punctuation token types.
  bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
  bracketR: new TokenType("]"),
  braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
  braceR: new TokenType("}"),
  parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
  parenR: new TokenType(")"),
  comma: new TokenType(",", beforeExpr),
  semi: new TokenType(";", beforeExpr),
  colon: new TokenType(":", beforeExpr),
  dot: new TokenType("."),
  question: new TokenType("?", beforeExpr),
  arrow: new TokenType("=>", beforeExpr),
  template: new TokenType("template"),
  ellipsis: new TokenType("...", beforeExpr),
  backQuote: new TokenType("`", startsExpr),
  dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),

  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator.
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.

  eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
  assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
  incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
  prefix: new TokenType("prefix", { beforeExpr: true, prefix: true, startsExpr: true }),
  logicalOR: binop("||", 1),
  logicalAND: binop("&&", 2),
  bitwiseOR: binop("|", 3),
  bitwiseXOR: binop("^", 4),
  bitwiseAND: binop("&", 5),
  equality: binop("==/!=", 6),
  relational: binop("</>", 7),
  bitShift: binop("<</>>", 8),
  plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
  modulo: binop("%", 10),
  star: binop("*", 10),
  slash: binop("/", 10)
};

exports.types = types;
// Map keyword names to token types.

var keywords = {};

exports.keywords = keywords;
// Succinct definitions of keyword token types
function kw(name) {
  var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

  options.keyword = name;
  keywords[name] = types["_" + name] = new TokenType(name, options);
}

kw("break");
kw("case", beforeExpr);
kw("catch");
kw("continue");
kw("debugger");
kw("default", beforeExpr);
kw("do", { isLoop: true });
kw("else", beforeExpr);
kw("finally");
kw("for", { isLoop: true });
kw("function", startsExpr);
kw("if");
kw("return", beforeExpr);
kw("switch");
kw("throw", beforeExpr);
kw("try");
kw("var");
kw("let");
kw("const");
kw("while", { isLoop: true });
kw("with");
kw("new", { beforeExpr: true, startsExpr: true });
kw("this", startsExpr);
kw("super", startsExpr);
kw("class");
kw("extends", beforeExpr);
kw("export");
kw("import");
kw("yield", { beforeExpr: true, startsExpr: true });
kw("null", startsExpr);
kw("true", startsExpr);
kw("false", startsExpr);
kw("in", { beforeExpr: true, binop: 7 });
kw("instanceof", { beforeExpr: true, binop: 7 });
kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true });
kw("void", { beforeExpr: true, prefix: true, startsExpr: true });
kw("delete", { beforeExpr: true, prefix: true, startsExpr: true });

},{}],15:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.isArray = isArray;
exports.has = has;

function isArray(obj) {
  return Object.prototype.toString.call(obj) === "[object Array]";
}

// Checks if an object has a property.

function has(obj, propName) {
  return Object.prototype.hasOwnProperty.call(obj, propName);
}

},{}],16:[function(_dereq_,module,exports){
// Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.

"use strict";

exports.__esModule = true;
exports.isNewLine = isNewLine;
var lineBreak = /\r\n?|\n|\u2028|\u2029/;
exports.lineBreak = lineBreak;
var lineBreakG = new RegExp(lineBreak.source, "g");

exports.lineBreakG = lineBreakG;

function isNewLine(code) {
  return code === 10 || code === 13 || code === 0x2028 || code == 0x2029;
}

var nonASCIIwhitespace = /[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
exports.nonASCIIwhitespace = nonASCIIwhitespace;

},{}]},{},[3])(3)
});
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],15:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}(g.acorn || (g.acorn = {})).loose = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
(function (global){
"use strict";(function(f){if(typeof exports === "object" && typeof module !== "undefined"){module.exports = f();}else if(typeof define === "function" && define.amd){define([],f);}else {var g;if(typeof window !== "undefined"){g = window;}else if(typeof global !== "undefined"){g = global;}else if(typeof self !== "undefined"){g = self;}else {g = this;}g.acorn = f();}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof _dereq_ == "function" && _dereq_;if(!u && a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '" + o + "'");throw (f.code = "MODULE_NOT_FOUND",f);}var l=n[o] = {exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e);},l,l.exports,e,t,n,r);}return n[o].exports;}var i=typeof _dereq_ == "function" && _dereq_;for(var o=0;o < r.length;o++) s(r[o]);return s;})({1:[function(_dereq_,module,exports){ // A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser
"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _identifier=_dereq_("./identifier");var _util=_dereq_("./util");var pp=_state.Parser.prototype; // Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.
pp.checkPropClash = function(prop,propHash){if(this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand))return;var key=prop.key,name=undefined;switch(key.type){case "Identifier":name = key.name;break;case "Literal":name = String(key.value);break;default:return;}var kind=prop.kind;if(this.options.ecmaVersion >= 6){if(name === "__proto__" && kind === "init"){if(propHash.proto)this.raise(key.start,"Redefinition of __proto__ property");propHash.proto = true;}return;}var other=undefined;if(_util.has(propHash,name)){other = propHash[name];var isGetSet=kind !== "init";if((this.strict || isGetSet) && other[kind] || !(isGetSet ^ other.init))this.raise(key.start,"Redefinition of property");}else {other = propHash[name] = {init:false,get:false,set:false};}other[kind] = true;}; // ### Expression parsing
// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.
// Parse a full expression. The optional arguments are used to
// forbid the `in` operator (in for loops initalization expressions)
// and provide reference for storing '=' operator inside shorthand
// property assignment in contexts where both object expression
// and object pattern might appear (so it's possible to raise
// delayed syntax error at correct position).
pp.parseExpression = function(noIn,refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseMaybeAssign(noIn,refShorthandDefaultPos);if(this.type === _tokentype.types.comma){var node=this.startNodeAt(startPos,startLoc);node.expressions = [expr];while(this.eat(_tokentype.types.comma)) node.expressions.push(this.parseMaybeAssign(noIn,refShorthandDefaultPos));return this.finishNode(node,"SequenceExpression");}return expr;}; // Parse an assignment expression. This includes applications of
// operators like `+=`.
pp.parseMaybeAssign = function(noIn,refShorthandDefaultPos,afterLeftParse){if(this.type == _tokentype.types._yield && this.inGenerator)return this.parseYield();var failOnShorthandAssign=undefined;if(!refShorthandDefaultPos){refShorthandDefaultPos = {start:0};failOnShorthandAssign = true;}else {failOnShorthandAssign = false;}var startPos=this.start,startLoc=this.startLoc;if(this.type == _tokentype.types.parenL || this.type == _tokentype.types.name)this.potentialArrowAt = this.start;var left=this.parseMaybeConditional(noIn,refShorthandDefaultPos);if(afterLeftParse)left = afterLeftParse.call(this,left,startPos,startLoc);if(this.type.isAssign){var node=this.startNodeAt(startPos,startLoc);node.operator = this.value;node.left = this.type === _tokentype.types.eq?this.toAssignable(left):left;refShorthandDefaultPos.start = 0; // reset because shorthand default was used correctly
this.checkLVal(left);this.next();node.right = this.parseMaybeAssign(noIn);return this.finishNode(node,"AssignmentExpression");}else if(failOnShorthandAssign && refShorthandDefaultPos.start){this.unexpected(refShorthandDefaultPos.start);}return left;}; // Parse a ternary conditional (`?:`) operator.
pp.parseMaybeConditional = function(noIn,refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseExprOps(noIn,refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;if(this.eat(_tokentype.types.question)){var node=this.startNodeAt(startPos,startLoc);node.test = expr;node.consequent = this.parseMaybeAssign();this.expect(_tokentype.types.colon);node.alternate = this.parseMaybeAssign(noIn);return this.finishNode(node,"ConditionalExpression");}return expr;}; // Start the precedence parser.
pp.parseExprOps = function(noIn,refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseMaybeUnary(refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;return this.parseExprOp(expr,startPos,startLoc,-1,noIn);}; // Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.
pp.parseExprOp = function(left,leftStartPos,leftStartLoc,minPrec,noIn){var prec=this.type.binop;if(prec != null && (!noIn || this.type !== _tokentype.types._in)){if(prec > minPrec){var node=this.startNodeAt(leftStartPos,leftStartLoc);node.left = left;node.operator = this.value;var op=this.type;this.next();var startPos=this.start,startLoc=this.startLoc;node.right = this.parseExprOp(this.parseMaybeUnary(),startPos,startLoc,prec,noIn);this.finishNode(node,op === _tokentype.types.logicalOR || op === _tokentype.types.logicalAND?"LogicalExpression":"BinaryExpression");return this.parseExprOp(node,leftStartPos,leftStartLoc,minPrec,noIn);}}return left;}; // Parse unary operators, both prefix and postfix.
pp.parseMaybeUnary = function(refShorthandDefaultPos){if(this.type.prefix){var node=this.startNode(),update=this.type === _tokentype.types.incDec;node.operator = this.value;node.prefix = true;this.next();node.argument = this.parseMaybeUnary();if(refShorthandDefaultPos && refShorthandDefaultPos.start)this.unexpected(refShorthandDefaultPos.start);if(update)this.checkLVal(node.argument);else if(this.strict && node.operator === "delete" && node.argument.type === "Identifier")this.raise(node.start,"Deleting local variable in strict mode");return this.finishNode(node,update?"UpdateExpression":"UnaryExpression");}var startPos=this.start,startLoc=this.startLoc;var expr=this.parseExprSubscripts(refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;while(this.type.postfix && !this.canInsertSemicolon()) {var node=this.startNodeAt(startPos,startLoc);node.operator = this.value;node.prefix = false;node.argument = expr;this.checkLVal(expr);this.next();expr = this.finishNode(node,"UpdateExpression");}return expr;}; // Parse call, dot, and `[]`-subscript expressions.
pp.parseExprSubscripts = function(refShorthandDefaultPos){var startPos=this.start,startLoc=this.startLoc;var expr=this.parseExprAtom(refShorthandDefaultPos);if(refShorthandDefaultPos && refShorthandDefaultPos.start)return expr;return this.parseSubscripts(expr,startPos,startLoc);};pp.parseSubscripts = function(base,startPos,startLoc,noCalls){for(;;) {if(this.eat(_tokentype.types.dot)){var node=this.startNodeAt(startPos,startLoc);node.object = base;node.property = this.parseIdent(true);node.computed = false;base = this.finishNode(node,"MemberExpression");}else if(this.eat(_tokentype.types.bracketL)){var node=this.startNodeAt(startPos,startLoc);node.object = base;node.property = this.parseExpression();node.computed = true;this.expect(_tokentype.types.bracketR);base = this.finishNode(node,"MemberExpression");}else if(!noCalls && this.eat(_tokentype.types.parenL)){var node=this.startNodeAt(startPos,startLoc);node.callee = base;node.arguments = this.parseExprList(_tokentype.types.parenR,false);base = this.finishNode(node,"CallExpression");}else if(this.type === _tokentype.types.backQuote){var node=this.startNodeAt(startPos,startLoc);node.tag = base;node.quasi = this.parseTemplate();base = this.finishNode(node,"TaggedTemplateExpression");}else {return base;}}}; // Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.
pp.parseExprAtom = function(refShorthandDefaultPos){var node=undefined,canBeArrow=this.potentialArrowAt == this.start;switch(this.type){case _tokentype.types._super:if(!this.inFunction)this.raise(this.start,"'super' outside of function or class");case _tokentype.types._this:var type=this.type === _tokentype.types._this?"ThisExpression":"Super";node = this.startNode();this.next();return this.finishNode(node,type);case _tokentype.types._yield:if(this.inGenerator)this.unexpected();case _tokentype.types.name:var startPos=this.start,startLoc=this.startLoc;var id=this.parseIdent(this.type !== _tokentype.types.name);if(canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow))return this.parseArrowExpression(this.startNodeAt(startPos,startLoc),[id]);return id;case _tokentype.types.regexp:var value=this.value;node = this.parseLiteral(value.value);node.regex = {pattern:value.pattern,flags:value.flags};return node;case _tokentype.types.num:case _tokentype.types.string:return this.parseLiteral(this.value);case _tokentype.types._null:case _tokentype.types._true:case _tokentype.types._false:node = this.startNode();node.value = this.type === _tokentype.types._null?null:this.type === _tokentype.types._true;node.raw = this.type.keyword;this.next();return this.finishNode(node,"Literal");case _tokentype.types.parenL:return this.parseParenAndDistinguishExpression(canBeArrow);case _tokentype.types.bracketL:node = this.startNode();this.next(); // check whether this is array comprehension or regular array
if(this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for){return this.parseComprehension(node,false);}node.elements = this.parseExprList(_tokentype.types.bracketR,true,true,refShorthandDefaultPos);return this.finishNode(node,"ArrayExpression");case _tokentype.types.braceL:return this.parseObj(false,refShorthandDefaultPos);case _tokentype.types._function:node = this.startNode();this.next();return this.parseFunction(node,false);case _tokentype.types._class:return this.parseClass(this.startNode(),false);case _tokentype.types._new:return this.parseNew();case _tokentype.types.backQuote:return this.parseTemplate();default:this.unexpected();}};pp.parseLiteral = function(value){var node=this.startNode();node.value = value;node.raw = this.input.slice(this.start,this.end);this.next();return this.finishNode(node,"Literal");};pp.parseParenExpression = function(){this.expect(_tokentype.types.parenL);var val=this.parseExpression();this.expect(_tokentype.types.parenR);return val;};pp.parseParenAndDistinguishExpression = function(canBeArrow){var startPos=this.start,startLoc=this.startLoc,val=undefined;if(this.options.ecmaVersion >= 6){this.next();if(this.options.ecmaVersion >= 7 && this.type === _tokentype.types._for){return this.parseComprehension(this.startNodeAt(startPos,startLoc),true);}var innerStartPos=this.start,innerStartLoc=this.startLoc;var exprList=[],first=true;var refShorthandDefaultPos={start:0},spreadStart=undefined,innerParenStart=undefined;while(this.type !== _tokentype.types.parenR) {first?first = false:this.expect(_tokentype.types.comma);if(this.type === _tokentype.types.ellipsis){spreadStart = this.start;exprList.push(this.parseParenItem(this.parseRest()));break;}else {if(this.type === _tokentype.types.parenL && !innerParenStart){innerParenStart = this.start;}exprList.push(this.parseMaybeAssign(false,refShorthandDefaultPos,this.parseParenItem));}}var innerEndPos=this.start,innerEndLoc=this.startLoc;this.expect(_tokentype.types.parenR);if(canBeArrow && !this.canInsertSemicolon() && this.eat(_tokentype.types.arrow)){if(innerParenStart)this.unexpected(innerParenStart);return this.parseParenArrowList(startPos,startLoc,exprList);}if(!exprList.length)this.unexpected(this.lastTokStart);if(spreadStart)this.unexpected(spreadStart);if(refShorthandDefaultPos.start)this.unexpected(refShorthandDefaultPos.start);if(exprList.length > 1){val = this.startNodeAt(innerStartPos,innerStartLoc);val.expressions = exprList;this.finishNodeAt(val,"SequenceExpression",innerEndPos,innerEndLoc);}else {val = exprList[0];}}else {val = this.parseParenExpression();}if(this.options.preserveParens){var par=this.startNodeAt(startPos,startLoc);par.expression = val;return this.finishNode(par,"ParenthesizedExpression");}else {return val;}};pp.parseParenItem = function(item){return item;};pp.parseParenArrowList = function(startPos,startLoc,exprList){return this.parseArrowExpression(this.startNodeAt(startPos,startLoc),exprList);}; // New's precedence is slightly tricky. It must allow its argument
// to be a `[]` or dot subscript expression, but not a call — at
// least, not without wrapping it in parentheses. Thus, it uses the
var empty=[];pp.parseNew = function(){var node=this.startNode();var meta=this.parseIdent(true);if(this.options.ecmaVersion >= 6 && this.eat(_tokentype.types.dot)){node.meta = meta;node.property = this.parseIdent(true);if(node.property.name !== "target")this.raise(node.property.start,"The only valid meta property for new is new.target");return this.finishNode(node,"MetaProperty");}var startPos=this.start,startLoc=this.startLoc;node.callee = this.parseSubscripts(this.parseExprAtom(),startPos,startLoc,true);if(this.eat(_tokentype.types.parenL))node.arguments = this.parseExprList(_tokentype.types.parenR,false);else node.arguments = empty;return this.finishNode(node,"NewExpression");}; // Parse template expression.
pp.parseTemplateElement = function(){var elem=this.startNode();elem.value = {raw:this.input.slice(this.start,this.end).replace(/\r\n?/g,'\n'),cooked:this.value};this.next();elem.tail = this.type === _tokentype.types.backQuote;return this.finishNode(elem,"TemplateElement");};pp.parseTemplate = function(){var node=this.startNode();this.next();node.expressions = [];var curElt=this.parseTemplateElement();node.quasis = [curElt];while(!curElt.tail) {this.expect(_tokentype.types.dollarBraceL);node.expressions.push(this.parseExpression());this.expect(_tokentype.types.braceR);node.quasis.push(curElt = this.parseTemplateElement());}this.next();return this.finishNode(node,"TemplateLiteral");}; // Parse an object literal or binding pattern.
pp.parseObj = function(isPattern,refShorthandDefaultPos){var node=this.startNode(),first=true,propHash={};node.properties = [];this.next();while(!this.eat(_tokentype.types.braceR)) {if(!first){this.expect(_tokentype.types.comma);if(this.afterTrailingComma(_tokentype.types.braceR))break;}else first = false;var prop=this.startNode(),isGenerator=undefined,startPos=undefined,startLoc=undefined;if(this.options.ecmaVersion >= 6){prop.method = false;prop.shorthand = false;if(isPattern || refShorthandDefaultPos){startPos = this.start;startLoc = this.startLoc;}if(!isPattern)isGenerator = this.eat(_tokentype.types.star);}this.parsePropertyName(prop);this.parsePropertyValue(prop,isPattern,isGenerator,startPos,startLoc,refShorthandDefaultPos);this.checkPropClash(prop,propHash);node.properties.push(this.finishNode(prop,"Property"));}return this.finishNode(node,isPattern?"ObjectPattern":"ObjectExpression");};pp.parsePropertyValue = function(prop,isPattern,isGenerator,startPos,startLoc,refShorthandDefaultPos){if(this.eat(_tokentype.types.colon)){prop.value = isPattern?this.parseMaybeDefault(this.start,this.startLoc):this.parseMaybeAssign(false,refShorthandDefaultPos);prop.kind = "init";}else if(this.options.ecmaVersion >= 6 && this.type === _tokentype.types.parenL){if(isPattern)this.unexpected();prop.kind = "init";prop.method = true;prop.value = this.parseMethod(isGenerator);}else if(this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type != _tokentype.types.comma && this.type != _tokentype.types.braceR)){if(isGenerator || isPattern)this.unexpected();prop.kind = prop.key.name;this.parsePropertyName(prop);prop.value = this.parseMethod(false);var paramCount=prop.kind === "get"?0:1;if(prop.value.params.length !== paramCount){var start=prop.value.start;if(prop.kind === "get")this.raise(start,"getter should have no params");else this.raise(start,"setter should have exactly one param");}}else if(this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier"){prop.kind = "init";if(isPattern){if(this.isKeyword(prop.key.name) || this.strict && (_identifier.reservedWords.strictBind(prop.key.name) || _identifier.reservedWords.strict(prop.key.name)) || !this.options.allowReserved && this.isReservedWord(prop.key.name))this.raise(prop.key.start,"Binding " + prop.key.name);prop.value = this.parseMaybeDefault(startPos,startLoc,prop.key);}else if(this.type === _tokentype.types.eq && refShorthandDefaultPos){if(!refShorthandDefaultPos.start)refShorthandDefaultPos.start = this.start;prop.value = this.parseMaybeDefault(startPos,startLoc,prop.key);}else {prop.value = prop.key;}prop.shorthand = true;}else this.unexpected();};pp.parsePropertyName = function(prop){if(this.options.ecmaVersion >= 6){if(this.eat(_tokentype.types.bracketL)){prop.computed = true;prop.key = this.parseMaybeAssign();this.expect(_tokentype.types.bracketR);return prop.key;}else {prop.computed = false;}}return prop.key = this.type === _tokentype.types.num || this.type === _tokentype.types.string?this.parseExprAtom():this.parseIdent(true);}; // Initialize empty function node.
pp.initFunction = function(node){node.id = null;if(this.options.ecmaVersion >= 6){node.generator = false;node.expression = false;}}; // Parse object or class method.
pp.parseMethod = function(isGenerator){var node=this.startNode();this.initFunction(node);this.expect(_tokentype.types.parenL);node.params = this.parseBindingList(_tokentype.types.parenR,false,false);var allowExpressionBody=undefined;if(this.options.ecmaVersion >= 6){node.generator = isGenerator;}this.parseFunctionBody(node,false);return this.finishNode(node,"FunctionExpression");}; // Parse arrow function expression with given parameters.
pp.parseArrowExpression = function(node,params){this.initFunction(node);node.params = this.toAssignableList(params,true);this.parseFunctionBody(node,true);return this.finishNode(node,"ArrowFunctionExpression");}; // Parse function body and check parameters.
pp.parseFunctionBody = function(node,allowExpression){var isExpression=allowExpression && this.type !== _tokentype.types.braceL;if(isExpression){node.body = this.parseMaybeAssign();node.expression = true;}else { // Start a new scope with regard to labels and the `inFunction`
// flag (restore them to their old value afterwards).
var oldInFunc=this.inFunction,oldInGen=this.inGenerator,oldLabels=this.labels;this.inFunction = true;this.inGenerator = node.generator;this.labels = [];node.body = this.parseBlock(true);node.expression = false;this.inFunction = oldInFunc;this.inGenerator = oldInGen;this.labels = oldLabels;} // If this is a strict mode function, verify that argument names
// are not repeated, and it does not try to bind the words `eval`
// or `arguments`.
if(this.strict || !isExpression && node.body.body.length && this.isUseStrict(node.body.body[0])){var nameHash={},oldStrict=this.strict;this.strict = true;if(node.id)this.checkLVal(node.id,true);for(var i=0;i < node.params.length;i++) {this.checkLVal(node.params[i],true,nameHash);}this.strict = oldStrict;}}; // Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).
pp.parseExprList = function(close,allowTrailingComma,allowEmpty,refShorthandDefaultPos){var elts=[],first=true;while(!this.eat(close)) {if(!first){this.expect(_tokentype.types.comma);if(allowTrailingComma && this.afterTrailingComma(close))break;}else first = false;var elt=undefined;if(allowEmpty && this.type === _tokentype.types.comma)elt = null;else if(this.type === _tokentype.types.ellipsis)elt = this.parseSpread(refShorthandDefaultPos);else elt = this.parseMaybeAssign(false,refShorthandDefaultPos);elts.push(elt);}return elts;}; // Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.
pp.parseIdent = function(liberal){var node=this.startNode();if(liberal && this.options.allowReserved == "never")liberal = false;if(this.type === _tokentype.types.name){if(!liberal && (!this.options.allowReserved && this.isReservedWord(this.value) || this.strict && _identifier.reservedWords.strict(this.value) && (this.options.ecmaVersion >= 6 || this.input.slice(this.start,this.end).indexOf("\\") == -1)))this.raise(this.start,"The keyword '" + this.value + "' is reserved");node.name = this.value;}else if(liberal && this.type.keyword){node.name = this.type.keyword;}else {this.unexpected();}this.next();return this.finishNode(node,"Identifier");}; // Parses yield expression inside generator.
pp.parseYield = function(){var node=this.startNode();this.next();if(this.type == _tokentype.types.semi || this.canInsertSemicolon() || this.type != _tokentype.types.star && !this.type.startsExpr){node.delegate = false;node.argument = null;}else {node.delegate = this.eat(_tokentype.types.star);node.argument = this.parseMaybeAssign();}return this.finishNode(node,"YieldExpression");}; // Parses array and generator comprehensions.
pp.parseComprehension = function(node,isGenerator){node.blocks = [];while(this.type === _tokentype.types._for) {var block=this.startNode();this.next();this.expect(_tokentype.types.parenL);block.left = this.parseBindingAtom();this.checkLVal(block.left,true);this.expectContextual("of");block.right = this.parseExpression();this.expect(_tokentype.types.parenR);node.blocks.push(this.finishNode(block,"ComprehensionBlock"));}node.filter = this.eat(_tokentype.types._if)?this.parseParenExpression():null;node.body = this.parseExpression();this.expect(isGenerator?_tokentype.types.parenR:_tokentype.types.bracketR);node.generator = isGenerator;return this.finishNode(node,"ComprehensionExpression");};},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],2:[function(_dereq_,module,exports){ // This is a trick taken from Esprima. It turns out that, on
// non-Chrome browsers, to check whether a string is in a set, a
// predicate containing a big ugly `switch` statement is faster than
// a regular expression, and on Chrome the two are about on par.
// This function uses `eval` (non-lexical) to produce such a
// predicate from a space-separated string of words.
//
// It starts by sorting the words by length.
"use strict";exports.__esModule = true;exports.isIdentifierStart = isIdentifierStart;exports.isIdentifierChar = isIdentifierChar;function makePredicate(words){words = words.split(" ");var f="",cats=[];out: for(var i=0;i < words.length;++i) {for(var j=0;j < cats.length;++j) {if(cats[j][0].length == words[i].length){cats[j].push(words[i]);continue out;}}cats.push([words[i]]);}function compareTo(arr){if(arr.length == 1)return f += "return str === " + JSON.stringify(arr[0]) + ";";f += "switch(str){";for(var i=0;i < arr.length;++i) {f += "case " + JSON.stringify(arr[i]) + ":";}f += "return true}return false;";} // When there are more than three length categories, an outer
// switch first dispatches on the lengths, to save on comparisons.
if(cats.length > 3){cats.sort(function(a,b){return b.length - a.length;});f += "switch(str.length){";for(var i=0;i < cats.length;++i) {var cat=cats[i];f += "case " + cat[0].length + ":";compareTo(cat);}f += "}"; // Otherwise, simply generate a flat `switch` statement.
}else {compareTo(words);}return new Function("str",f);} // Reserved word lists for various dialects of the language
var reservedWords={3:makePredicate("abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile"),5:makePredicate("class enum extends super const export import"),6:makePredicate("enum await"),strict:makePredicate("implements interface let package private protected public static yield"),strictBind:makePredicate("eval arguments")};exports.reservedWords = reservedWords; // And the keywords
var ecma5AndLessKeywords="break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";var keywords={5:makePredicate(ecma5AndLessKeywords),6:makePredicate(ecma5AndLessKeywords + " let const class extends export import yield super")};exports.keywords = keywords; // ## Character categories
// Big ugly regular expressions that match characters in the
// whitespace, identifier, and identifier-start categories. These
// are only applied when a character is found to actually have a
// code point above 128.
// Generated by `tools/generate-identifier-regex.js`.
var nonASCIIidentifierStartChars="ªµºÀ-ÖØ-öø-ˁˆ-ˑˠ-ˤˬˮͰ-ʹͶͷͺ-ͽͿΆΈ-ΊΌΎ-ΡΣ-ϵϷ-ҁҊ-ԯԱ-Ֆՙա-ևא-תװ-ײؠ-يٮٯٱ-ۓەۥۦۮۯۺ-ۼۿܐܒ-ܯݍ-ޥޱߊ-ߪߴߵߺࠀ-ࠕࠚࠤࠨࡀ-ࡘࢠ-ࢲऄ-हऽॐक़-ॡॱ-ঀঅ-ঌএঐও-নপ-রলশ-হঽৎড়ঢ়য়-ৡৰৱਅ-ਊਏਐਓ-ਨਪ-ਰਲਲ਼ਵਸ਼ਸਹਖ਼-ੜਫ਼ੲ-ੴઅ-ઍએ-ઑઓ-નપ-રલળવ-હઽૐૠૡଅ-ଌଏଐଓ-ନପ-ରଲଳଵ-ହଽଡ଼ଢ଼ୟ-ୡୱஃஅ-ஊஎ-ஐஒ-கஙசஜஞடணதந-பம-ஹௐఅ-ఌఎ-ఐఒ-నప-హఽౘౙౠౡಅ-ಌಎ-ಐಒ-ನಪ-ಳವ-ಹಽೞೠೡೱೲഅ-ഌഎ-ഐഒ-ഺഽൎൠൡൺ-ൿඅ-ඖක-නඳ-රලව-ෆก-ะาำเ-ๆກຂຄງຈຊຍດ-ທນ-ຟມ-ຣລວສຫອ-ະາຳຽເ-ໄໆໜ-ໟༀཀ-ཇཉ-ཬྈ-ྌက-ဪဿၐ-ၕၚ-ၝၡၥၦၮ-ၰၵ-ႁႎႠ-ჅჇჍა-ჺჼ-ቈቊ-ቍቐ-ቖቘቚ-ቝበ-ኈኊ-ኍነ-ኰኲ-ኵኸ-ኾዀዂ-ዅወ-ዖዘ-ጐጒ-ጕጘ-ፚᎀ-ᎏᎠ-Ᏼᐁ-ᙬᙯ-ᙿᚁ-ᚚᚠ-ᛪᛮ-ᛸᜀ-ᜌᜎ-ᜑᜠ-ᜱᝀ-ᝑᝠ-ᝬᝮ-ᝰក-ឳៗៜᠠ-ᡷᢀ-ᢨᢪᢰ-ᣵᤀ-ᤞᥐ-ᥭᥰ-ᥴᦀ-ᦫᧁ-ᧇᨀ-ᨖᨠ-ᩔᪧᬅ-ᬳᭅ-ᭋᮃ-ᮠᮮᮯᮺ-ᯥᰀ-ᰣᱍ-ᱏᱚ-ᱽᳩ-ᳬᳮ-ᳱᳵᳶᴀ-ᶿḀ-ἕἘ-Ἕἠ-ὅὈ-Ὅὐ-ὗὙὛὝὟ-ώᾀ-ᾴᾶ-ᾼιῂ-ῄῆ-ῌῐ-ΐῖ-Ίῠ-Ῥῲ-ῴῶ-ῼⁱⁿₐ-ₜℂℇℊ-ℓℕ℘-ℝℤΩℨK-ℹℼ-ℿⅅ-ⅉⅎⅠ-ↈⰀ-Ⱞⰰ-ⱞⱠ-ⳤⳫ-ⳮⳲⳳⴀ-ⴥⴧⴭⴰ-ⵧⵯⶀ-ⶖⶠ-ⶦⶨ-ⶮⶰ-ⶶⶸ-ⶾⷀ-ⷆⷈ-ⷎⷐ-ⷖⷘ-ⷞ々-〇〡-〩〱-〵〸-〼ぁ-ゖ゛-ゟァ-ヺー-ヿㄅ-ㄭㄱ-ㆎㆠ-ㆺㇰ-ㇿ㐀-䶵一-鿌ꀀ-ꒌꓐ-ꓽꔀ-ꘌꘐ-ꘟꘪꘫꙀ-ꙮꙿ-ꚝꚠ-ꛯꜗ-ꜟꜢ-ꞈꞋ-ꞎꞐ-ꞭꞰꞱꟷ-ꠁꠃ-ꠅꠇ-ꠊꠌ-ꠢꡀ-ꡳꢂ-ꢳꣲ-ꣷꣻꤊ-ꤥꤰ-ꥆꥠ-ꥼꦄ-ꦲꧏꧠ-ꧤꧦ-ꧯꧺ-ꧾꨀ-ꨨꩀ-ꩂꩄ-ꩋꩠ-ꩶꩺꩾ-ꪯꪱꪵꪶꪹ-ꪽꫀꫂꫛ-ꫝꫠ-ꫪꫲ-ꫴꬁ-ꬆꬉ-ꬎꬑ-ꬖꬠ-ꬦꬨ-ꬮꬰ-ꭚꭜ-ꭟꭤꭥꯀ-ꯢ가-힣ힰ-ퟆퟋ-ퟻ豈-舘並-龎ﬀ-ﬆﬓ-ﬗיִײַ-ﬨשׁ-זּטּ-לּמּנּסּףּפּצּ-ﮱﯓ-ﴽﵐ-ﶏﶒ-ﷇﷰ-ﷻﹰ-ﹴﹶ-ﻼＡ-Ｚａ-ｚｦ-ﾾￂ-ￇￊ-ￏￒ-ￗￚ-ￜ";var nonASCIIidentifierChars="‌‍·̀-ͯ·҃-֑҇-ׇֽֿׁׂׅׄؐ-ًؚ-٩ٰۖ-ۜ۟-۪ۤۧۨ-ۭ۰-۹ܑܰ-݊ަ-ް߀-߉߫-߳ࠖ-࠙ࠛ-ࠣࠥ-ࠧࠩ-࡙࠭-࡛ࣤ-ःऺ-़ा-ॏ॑-ॗॢॣ०-९ঁ-ঃ়া-ৄেৈো-্ৗৢৣ০-৯ਁ-ਃ਼ਾ-ੂੇੈੋ-੍ੑ੦-ੱੵઁ-ઃ઼ા-ૅે-ૉો-્ૢૣ૦-૯ଁ-ଃ଼ା-ୄେୈୋ-୍ୖୗୢୣ୦-୯ஂா-ூெ-ைொ-்ௗ௦-௯ఀ-ఃా-ౄె-ైొ-్ౕౖౢౣ౦-౯ಁ-ಃ಼ಾ-ೄೆ-ೈೊ-್ೕೖೢೣ೦-೯ഁ-ഃാ-ൄെ-ൈൊ-്ൗൢൣ൦-൯ංඃ්ා-ුූෘ-ෟ෦-෯ෲෳัิ-ฺ็-๎๐-๙ັິ-ູົຼ່-ໍ໐-໙༘༙༠-༩༹༵༷༾༿ཱ-྄྆྇ྍ-ྗྙ-ྼ࿆ါ-ှ၀-၉ၖ-ၙၞ-ၠၢ-ၤၧ-ၭၱ-ၴႂ-ႍႏ-ႝ፝-፟፩-፱ᜒ-᜔ᜲ-᜴ᝒᝓᝲᝳ឴-៓៝០-៩᠋-᠍᠐-᠙ᢩᤠ-ᤫᤰ-᤻᥆-᥏ᦰ-ᧀᧈᧉ᧐-᧚ᨗ-ᨛᩕ-ᩞ᩠-᩿᩼-᪉᪐-᪙᪰-᪽ᬀ-ᬄ᬴-᭄᭐-᭙᭫-᭳ᮀ-ᮂᮡ-ᮭ᮰-᮹᯦-᯳ᰤ-᰷᱀-᱉᱐-᱙᳐-᳔᳒-᳨᳭ᳲ-᳴᳸᳹᷀-᷵᷼-᷿‿⁀⁔⃐-⃥⃜⃡-⃰⳯-⵿⳱ⷠ-〪ⷿ-゙゚〯꘠-꘩꙯ꙴ-꙽ꚟ꛰꛱ꠂ꠆ꠋꠣ-ꠧꢀꢁꢴ-꣄꣐-꣙꣠-꣱꤀-꤉ꤦ-꤭ꥇ-꥓ꦀ-ꦃ꦳-꧀꧐-꧙ꧥ꧰-꧹ꨩ-ꨶꩃꩌꩍ꩐-꩙ꩻ-ꩽꪰꪲ-ꪴꪷꪸꪾ꪿꫁ꫫ-ꫯꫵ꫶ꯣ-ꯪ꯬꯭꯰-꯹ﬞ︀-️︠-︭︳︴﹍-﹏０-９＿";var nonASCIIidentifierStart=new RegExp("[" + nonASCIIidentifierStartChars + "]");var nonASCIIidentifier=new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");nonASCIIidentifierStartChars = nonASCIIidentifierChars = null; // These are a run-length and offset encoded representation of the
// >0xffff code points that are a valid part of identifiers. The
// offset starts at 0x10000, and each pair of numbers represents an
// offset to the next range, and then a size of the range. They were
// generated by tools/generate-identifier-regex.js
var astralIdentifierStartCodes=[0,11,2,25,2,18,2,1,2,14,3,13,35,122,70,52,268,28,4,48,48,31,17,26,6,37,11,29,3,35,5,7,2,4,43,157,99,39,9,51,157,310,10,21,11,7,153,5,3,0,2,43,2,1,4,0,3,22,11,22,10,30,98,21,11,25,71,55,7,1,65,0,16,3,2,2,2,26,45,28,4,28,36,7,2,27,28,53,11,21,11,18,14,17,111,72,955,52,76,44,33,24,27,35,42,34,4,0,13,47,15,3,22,0,38,17,2,24,133,46,39,7,3,1,3,21,2,6,2,1,2,4,4,0,32,4,287,47,21,1,2,0,185,46,82,47,21,0,60,42,502,63,32,0,449,56,1288,920,104,110,2962,1070,13266,568,8,30,114,29,19,47,17,3,32,20,6,18,881,68,12,0,67,12,16481,1,3071,106,6,12,4,8,8,9,5991,84,2,70,2,1,3,0,3,1,3,3,2,11,2,0,2,6,2,64,2,3,3,7,2,6,2,27,2,3,2,4,2,0,4,6,2,339,3,24,2,24,2,30,2,24,2,30,2,24,2,30,2,24,2,30,2,24,2,7,4149,196,1340,3,2,26,2,1,2,0,3,0,2,9,2,3,2,0,2,0,7,0,5,0,2,0,2,0,2,2,2,1,2,0,3,0,2,0,2,0,2,0,2,0,2,1,2,0,3,3,2,6,2,3,2,3,2,0,2,9,2,16,6,2,2,4,2,16,4421,42710,42,4148,12,221,16355,541];var astralIdentifierCodes=[509,0,227,0,150,4,294,9,1368,2,2,1,6,3,41,2,5,0,166,1,1306,2,54,14,32,9,16,3,46,10,54,9,7,2,37,13,2,9,52,0,13,2,49,13,16,9,83,11,168,11,6,9,8,2,57,0,2,6,3,1,3,2,10,0,11,1,3,6,4,4,316,19,13,9,214,6,3,8,112,16,16,9,82,12,9,9,535,9,20855,9,135,4,60,6,26,9,1016,45,17,3,19723,1,5319,4,4,5,9,7,3,6,31,3,149,2,1418,49,4305,6,792618,239]; // This has a complexity linear to the value of the code. The
// assumption is that looking up astral identifier characters is
// rare.
function isInAstralSet(code,set){var pos=0x10000;for(var i=0;i < set.length;i += 2) {pos += set[i];if(pos > code)return false;pos += set[i + 1];if(pos >= code)return true;}} // Test whether a given character code starts an identifier.
function isIdentifierStart(code,astral){if(code < 65)return code === 36;if(code < 91)return true;if(code < 97)return code === 95;if(code < 123)return true;if(code <= 0xffff)return code >= 0xaa && nonASCIIidentifierStart.test(String.fromCharCode(code));if(astral === false)return false;return isInAstralSet(code,astralIdentifierStartCodes);} // Test whether a given character is part of an identifier.
function isIdentifierChar(code,astral){if(code < 48)return code === 36;if(code < 58)return true;if(code < 65)return false;if(code < 91)return true;if(code < 97)return code === 95;if(code < 123)return true;if(code <= 0xffff)return code >= 0xaa && nonASCIIidentifier.test(String.fromCharCode(code));if(astral === false)return false;return isInAstralSet(code,astralIdentifierStartCodes) || isInAstralSet(code,astralIdentifierCodes);}},{}],3:[function(_dereq_,module,exports){ // Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke, Ingvar Stepanyan, and
// various contributors and released under an MIT license.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/marijnh/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/marijnh/acorn/issues
//
// This file defines the main parser interface. The library also comes
// with a [error-tolerant parser][dammit] and an
// [abstract syntax tree walker][walk], defined in other files.
//
// [dammit]: acorn_loose.js
// [walk]: util/walk.js
"use strict";exports.__esModule = true;exports.parse = parse;exports.parseExpressionAt = parseExpressionAt;exports.tokenizer = tokenizer;var _state=_dereq_("./state");var _options=_dereq_("./options");_dereq_("./parseutil");_dereq_("./statement");_dereq_("./lval");_dereq_("./expression");_dereq_("./location");exports.Parser = _state.Parser;exports.plugins = _state.plugins;exports.defaultOptions = _options.defaultOptions;var _locutil=_dereq_("./locutil");exports.Position = _locutil.Position;exports.SourceLocation = _locutil.SourceLocation;exports.getLineInfo = _locutil.getLineInfo;var _node=_dereq_("./node");exports.Node = _node.Node;var _tokentype=_dereq_("./tokentype");exports.TokenType = _tokentype.TokenType;exports.tokTypes = _tokentype.types;var _tokencontext=_dereq_("./tokencontext");exports.TokContext = _tokencontext.TokContext;exports.tokContexts = _tokencontext.types;var _identifier=_dereq_("./identifier");exports.isIdentifierChar = _identifier.isIdentifierChar;exports.isIdentifierStart = _identifier.isIdentifierStart;var _tokenize=_dereq_("./tokenize");exports.Token = _tokenize.Token;var _whitespace=_dereq_("./whitespace");exports.isNewLine = _whitespace.isNewLine;exports.lineBreak = _whitespace.lineBreak;exports.lineBreakG = _whitespace.lineBreakG;var version="2.2.0";exports.version = version; // The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and
// returns an abstract syntax tree as specified by [Mozilla parser
// API][api].
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API
function parse(input,options){return new _state.Parser(options,input).parse();} // This function tries to parse a single expression at a given
// offset in a string. Useful for parsing mixed-language formats
// that embed JavaScript expressions.
function parseExpressionAt(input,pos,options){var p=new _state.Parser(options,input,pos);p.nextToken();return p.parseExpression();} // Acorn is organized as a tokenizer and a recursive-descent parser.
// The `tokenize` export provides an interface to the tokenizer.
function tokenizer(input,options){return new _state.Parser(options,input);}},{"./expression":1,"./identifier":2,"./location":4,"./locutil":5,"./lval":6,"./node":7,"./options":8,"./parseutil":9,"./state":10,"./statement":11,"./tokencontext":12,"./tokenize":13,"./tokentype":14,"./whitespace":16}],4:[function(_dereq_,module,exports){"use strict";var _state=_dereq_("./state");var _locutil=_dereq_("./locutil");var pp=_state.Parser.prototype; // This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.
pp.raise = function(pos,message){var loc=_locutil.getLineInfo(this.input,pos);message += " (" + loc.line + ":" + loc.column + ")";var err=new SyntaxError(message);err.pos = pos;err.loc = loc;err.raisedAt = this.pos;throw err;};pp.curPosition = function(){if(this.options.locations){return new _locutil.Position(this.curLine,this.pos - this.lineStart);}};},{"./locutil":5,"./state":10}],5:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;exports.getLineInfo = getLineInfo;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _whitespace=_dereq_("./whitespace"); // These are used when `options.locations` is on, for the
// `startLoc` and `endLoc` properties.
var Position=(function(){function Position(line,col){_classCallCheck(this,Position);this.line = line;this.column = col;}Position.prototype.offset = function offset(n){return new Position(this.line,this.column + n);};return Position;})();exports.Position = Position;var SourceLocation=function SourceLocation(p,start,end){_classCallCheck(this,SourceLocation);this.start = start;this.end = end;if(p.sourceFile !== null)this.source = p.sourceFile;} // The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.
;exports.SourceLocation = SourceLocation;function getLineInfo(input,offset){for(var line=1,cur=0;;) {_whitespace.lineBreakG.lastIndex = cur;var match=_whitespace.lineBreakG.exec(input);if(match && match.index < offset){++line;cur = match.index + match[0].length;}else {return new Position(line,offset - cur);}}}},{"./whitespace":16}],6:[function(_dereq_,module,exports){"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _identifier=_dereq_("./identifier");var _util=_dereq_("./util");var pp=_state.Parser.prototype; // Convert existing expression atom to assignable pattern
// if possible.
pp.toAssignable = function(node,isBinding){if(this.options.ecmaVersion >= 6 && node){switch(node.type){case "Identifier":case "ObjectPattern":case "ArrayPattern":case "AssignmentPattern":break;case "ObjectExpression":node.type = "ObjectPattern";for(var i=0;i < node.properties.length;i++) {var prop=node.properties[i];if(prop.kind !== "init")this.raise(prop.key.start,"Object pattern can't contain getter or setter");this.toAssignable(prop.value,isBinding);}break;case "ArrayExpression":node.type = "ArrayPattern";this.toAssignableList(node.elements,isBinding);break;case "AssignmentExpression":if(node.operator === "="){node.type = "AssignmentPattern";delete node.operator;}else {this.raise(node.left.end,"Only '=' operator can be used for specifying default value.");}break;case "ParenthesizedExpression":node.expression = this.toAssignable(node.expression,isBinding);break;case "MemberExpression":if(!isBinding)break;default:this.raise(node.start,"Assigning to rvalue");}}return node;}; // Convert list of expression atoms to binding list.
pp.toAssignableList = function(exprList,isBinding){var end=exprList.length;if(end){var last=exprList[end - 1];if(last && last.type == "RestElement"){--end;}else if(last && last.type == "SpreadElement"){last.type = "RestElement";var arg=last.argument;this.toAssignable(arg,isBinding);if(arg.type !== "Identifier" && arg.type !== "MemberExpression" && arg.type !== "ArrayPattern")this.unexpected(arg.start);--end;}}for(var i=0;i < end;i++) {var elt=exprList[i];if(elt)this.toAssignable(elt,isBinding);}return exprList;}; // Parses spread element.
pp.parseSpread = function(refShorthandDefaultPos){var node=this.startNode();this.next();node.argument = this.parseMaybeAssign(refShorthandDefaultPos);return this.finishNode(node,"SpreadElement");};pp.parseRest = function(){var node=this.startNode();this.next();node.argument = this.type === _tokentype.types.name || this.type === _tokentype.types.bracketL?this.parseBindingAtom():this.unexpected();return this.finishNode(node,"RestElement");}; // Parses lvalue (assignable) atom.
pp.parseBindingAtom = function(){if(this.options.ecmaVersion < 6)return this.parseIdent();switch(this.type){case _tokentype.types.name:return this.parseIdent();case _tokentype.types.bracketL:var node=this.startNode();this.next();node.elements = this.parseBindingList(_tokentype.types.bracketR,true,true);return this.finishNode(node,"ArrayPattern");case _tokentype.types.braceL:return this.parseObj(true);default:this.unexpected();}};pp.parseBindingList = function(close,allowEmpty,allowTrailingComma){var elts=[],first=true;while(!this.eat(close)) {if(first)first = false;else this.expect(_tokentype.types.comma);if(allowEmpty && this.type === _tokentype.types.comma){elts.push(null);}else if(allowTrailingComma && this.afterTrailingComma(close)){break;}else if(this.type === _tokentype.types.ellipsis){var rest=this.parseRest();this.parseBindingListItem(rest);elts.push(rest);this.expect(close);break;}else {var elem=this.parseMaybeDefault(this.start,this.startLoc);this.parseBindingListItem(elem);elts.push(elem);}}return elts;};pp.parseBindingListItem = function(param){return param;}; // Parses assignment pattern around given atom if possible.
pp.parseMaybeDefault = function(startPos,startLoc,left){left = left || this.parseBindingAtom();if(!this.eat(_tokentype.types.eq))return left;var node=this.startNodeAt(startPos,startLoc);node.left = left;node.right = this.parseMaybeAssign();return this.finishNode(node,"AssignmentPattern");}; // Verify that a node is an lval — something that can be assigned
// to.
pp.checkLVal = function(expr,isBinding,checkClashes){switch(expr.type){case "Identifier":if(this.strict && (_identifier.reservedWords.strictBind(expr.name) || _identifier.reservedWords.strict(expr.name)))this.raise(expr.start,(isBinding?"Binding ":"Assigning to ") + expr.name + " in strict mode");if(checkClashes){if(_util.has(checkClashes,expr.name))this.raise(expr.start,"Argument name clash in strict mode");checkClashes[expr.name] = true;}break;case "MemberExpression":if(isBinding)this.raise(expr.start,(isBinding?"Binding":"Assigning to") + " member expression");break;case "ObjectPattern":for(var i=0;i < expr.properties.length;i++) {this.checkLVal(expr.properties[i].value,isBinding,checkClashes);}break;case "ArrayPattern":for(var i=0;i < expr.elements.length;i++) {var elem=expr.elements[i];if(elem)this.checkLVal(elem,isBinding,checkClashes);}break;case "AssignmentPattern":this.checkLVal(expr.left,isBinding,checkClashes);break;case "RestElement":this.checkLVal(expr.argument,isBinding,checkClashes);break;case "ParenthesizedExpression":this.checkLVal(expr.expression,isBinding,checkClashes);break;default:this.raise(expr.start,(isBinding?"Binding":"Assigning to") + " rvalue");}};},{"./identifier":2,"./state":10,"./tokentype":14,"./util":15}],7:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _state=_dereq_("./state");var _locutil=_dereq_("./locutil");var Node=function Node(parser,pos,loc){_classCallCheck(this,Node);this.type = "";this.start = pos;this.end = 0;if(parser.options.locations)this.loc = new _locutil.SourceLocation(parser,loc);if(parser.options.directSourceFile)this.sourceFile = parser.options.directSourceFile;if(parser.options.ranges)this.range = [pos,0];} // Start an AST node, attaching a start offset.
;exports.Node = Node;var pp=_state.Parser.prototype;pp.startNode = function(){return new Node(this,this.start,this.startLoc);};pp.startNodeAt = function(pos,loc){return new Node(this,pos,loc);}; // Finish an AST node, adding `type` and `end` properties.
function finishNodeAt(node,type,pos,loc){node.type = type;node.end = pos;if(this.options.locations)node.loc.end = loc;if(this.options.ranges)node.range[1] = pos;return node;}pp.finishNode = function(node,type){return finishNodeAt.call(this,node,type,this.lastTokEnd,this.lastTokEndLoc);}; // Finish node at given position
pp.finishNodeAt = function(node,type,pos,loc){return finishNodeAt.call(this,node,type,pos,loc);};},{"./locutil":5,"./state":10}],8:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;exports.getOptions = getOptions;var _util=_dereq_("./util");var _locutil=_dereq_("./locutil"); // A second optional argument can be given to further configure
// the parser process. These options are recognized:
var defaultOptions={ // `ecmaVersion` indicates the ECMAScript version to parse. Must
// be either 3, or 5, or 6. This influences support for strict
// mode, the set of reserved words, support for getters and
// setters and other features.
ecmaVersion:5, // Source type ("script" or "module") for different semantics
sourceType:"script", // `onInsertedSemicolon` can be a callback that will be called
// when a semicolon is automatically inserted. It will be passed
// th position of the comma as an offset, and if `locations` is
// enabled, it is given the location as a `{line, column}` object
// as second argument.
onInsertedSemicolon:null, // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
// trailing commas.
onTrailingComma:null, // By default, reserved words are not enforced. Disable
// `allowReserved` to enforce them. When this option has the
// value "never", reserved words and keywords can also not be
// used as property names.
allowReserved:true, // When enabled, a return at the top level is not considered an
// error.
allowReturnOutsideFunction:false, // When enabled, import/export statements are not constrained to
// appearing at the top of the program.
allowImportExportEverywhere:false, // When enabled, hashbang directive in the beginning of file
// is allowed and treated as a line comment.
allowHashBang:false, // When `locations` is on, `loc` properties holding objects with
// `start` and `end` properties in `{line, column}` form (with
// line being 1-based and column 0-based) will be attached to the
// nodes.
locations:false, // A function can be passed as `onToken` option, which will
// cause Acorn to call that function with object in the same
// format as tokenize() returns. Note that you are not
// allowed to call the parser from the callback—that will
// corrupt its internal state.
onToken:null, // A function can be passed as `onComment` option, which will
// cause Acorn to call that function with `(block, text, start,
// end)` parameters whenever a comment is skipped. `block` is a
// boolean indicating whether this is a block (`/* */`) comment,
// `text` is the content of the comment, and `start` and `end` are
// character offsets that denote the start and end of the comment.
// When the `locations` option is on, two more parameters are
// passed, the full `{line, column}` locations of the start and
// end of the comments. Note that you are not allowed to call the
// parser from the callback—that will corrupt its internal state.
onComment:null, // Nodes have their start and end characters offsets recorded in
// `start` and `end` properties (directly on the node, rather than
// the `loc` object, which holds line/column data. To also add a
// [semi-standardized][range] `range` property holding a `[start,
// end]` array with the same numbers, set the `ranges` option to
// `true`.
//
// [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
ranges:false, // It is possible to parse multiple files into a single AST by
// passing the tree produced by parsing the first file as
// `program` option in subsequent parses. This will add the
// toplevel forms of the parsed file to the `Program` (top) node
// of an existing parse tree.
program:null, // When `locations` is on, you can pass this to record the source
// file in every node's `loc` object.
sourceFile:null, // This value, if given, is stored in every node, whether
// `locations` is on or off.
directSourceFile:null, // When enabled, parenthesized expressions are represented by
// (non-standard) ParenthesizedExpression nodes
preserveParens:false,plugins:{}};exports.defaultOptions = defaultOptions; // Interpret and default an options object
function getOptions(opts){var options={};for(var opt in defaultOptions) {options[opt] = opts && _util.has(opts,opt)?opts[opt]:defaultOptions[opt];}if(_util.isArray(options.onToken)){(function(){var tokens=options.onToken;options.onToken = function(token){return tokens.push(token);};})();}if(_util.isArray(options.onComment))options.onComment = pushComment(options,options.onComment);return options;}function pushComment(options,array){return function(block,text,start,end,startLoc,endLoc){var comment={type:block?'Block':'Line',value:text,start:start,end:end};if(options.locations)comment.loc = new _locutil.SourceLocation(this,startLoc,endLoc);if(options.ranges)comment.range = [start,end];array.push(comment);};}},{"./locutil":5,"./util":15}],9:[function(_dereq_,module,exports){"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _whitespace=_dereq_("./whitespace");var pp=_state.Parser.prototype; // ## Parser utilities
// Test whether a statement node is the string literal `"use strict"`.
pp.isUseStrict = function(stmt){return this.options.ecmaVersion >= 5 && stmt.type === "ExpressionStatement" && stmt.expression.type === "Literal" && stmt.expression.raw.slice(1,-1) === "use strict";}; // Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.
pp.eat = function(type){if(this.type === type){this.next();return true;}else {return false;}}; // Tests whether parsed token is a contextual keyword.
pp.isContextual = function(name){return this.type === _tokentype.types.name && this.value === name;}; // Consumes contextual keyword if possible.
pp.eatContextual = function(name){return this.value === name && this.eat(_tokentype.types.name);}; // Asserts that following token is given contextual keyword.
pp.expectContextual = function(name){if(!this.eatContextual(name))this.unexpected();}; // Test whether a semicolon can be inserted at the current position.
pp.canInsertSemicolon = function(){return this.type === _tokentype.types.eof || this.type === _tokentype.types.braceR || _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.start));};pp.insertSemicolon = function(){if(this.canInsertSemicolon()){if(this.options.onInsertedSemicolon)this.options.onInsertedSemicolon(this.lastTokEnd,this.lastTokEndLoc);return true;}}; // Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.
pp.semicolon = function(){if(!this.eat(_tokentype.types.semi) && !this.insertSemicolon())this.unexpected();};pp.afterTrailingComma = function(tokType){if(this.type == tokType){if(this.options.onTrailingComma)this.options.onTrailingComma(this.lastTokStart,this.lastTokStartLoc);this.next();return true;}}; // Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.
pp.expect = function(type){this.eat(type) || this.unexpected();}; // Raise an unexpected token error.
pp.unexpected = function(pos){this.raise(pos != null?pos:this.start,"Unexpected token");};},{"./state":10,"./tokentype":14,"./whitespace":16}],10:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _identifier=_dereq_("./identifier");var _tokentype=_dereq_("./tokentype");var _whitespace=_dereq_("./whitespace");var _options=_dereq_("./options"); // Registered plugins
var plugins={};exports.plugins = plugins;var Parser=(function(){function Parser(options,input,startPos){_classCallCheck(this,Parser);this.options = _options.getOptions(options);this.sourceFile = this.options.sourceFile;this.isKeyword = _identifier.keywords[this.options.ecmaVersion >= 6?6:5];this.isReservedWord = _identifier.reservedWords[this.options.ecmaVersion];this.input = String(input); // Used to signal to callers of `readWord1` whether the word
// contained any escape sequences. This is needed because words with
// escape sequences must not be interpreted as keywords.
this.containsEsc = false; // Load plugins
this.loadPlugins(this.options.plugins); // Set up token state
// The current position of the tokenizer in the input.
if(startPos){this.pos = startPos;this.lineStart = Math.max(0,this.input.lastIndexOf("\n",startPos));this.curLine = this.input.slice(0,this.lineStart).split(_whitespace.lineBreak).length;}else {this.pos = this.lineStart = 0;this.curLine = 1;} // Properties of the current token:
// Its type
this.type = _tokentype.types.eof; // For tokens that include more information than their type, the value
this.value = null; // Its start and end offset
this.start = this.end = this.pos; // And, if locations are used, the {line, column} object
// corresponding to those offsets
this.startLoc = this.endLoc = this.curPosition(); // Position information for the previous token
this.lastTokEndLoc = this.lastTokStartLoc = null;this.lastTokStart = this.lastTokEnd = this.pos; // The context stack is used to superficially track syntactic
// context to predict whether a regular expression is allowed in a
// given position.
this.context = this.initialContext();this.exprAllowed = true; // Figure out if it's a module code.
this.strict = this.inModule = this.options.sourceType === "module"; // Used to signify the start of a potential arrow function
this.potentialArrowAt = -1; // Flags to track whether we are in a function, a generator.
this.inFunction = this.inGenerator = false; // Labels in scope.
this.labels = []; // If enabled, skip leading hashbang line.
if(this.pos === 0 && this.options.allowHashBang && this.input.slice(0,2) === '#!')this.skipLineComment(2);}Parser.prototype.extend = function extend(name,f){this[name] = f(this[name]);};Parser.prototype.loadPlugins = function loadPlugins(pluginConfigs){for(var _name in pluginConfigs) {var plugin=plugins[_name];if(!plugin)throw new Error("Plugin '" + _name + "' not found");plugin(this,pluginConfigs[_name]);}};Parser.prototype.parse = function parse(){var node=this.options.program || this.startNode();this.nextToken();return this.parseTopLevel(node);};return Parser;})();exports.Parser = Parser;},{"./identifier":2,"./options":8,"./tokentype":14,"./whitespace":16}],11:[function(_dereq_,module,exports){"use strict";var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _whitespace=_dereq_("./whitespace");var pp=_state.Parser.prototype; // ### Statement parsing
// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.  Optionally takes a
// `program` argument.  If present, the statements will be appended
// to its body instead of creating a new node.
pp.parseTopLevel = function(node){var first=true;if(!node.body)node.body = [];while(this.type !== _tokentype.types.eof) {var stmt=this.parseStatement(true,true);node.body.push(stmt);if(first){if(this.isUseStrict(stmt))this.setStrict(true);first = false;}}this.next();if(this.options.ecmaVersion >= 6){node.sourceType = this.options.sourceType;}return this.finishNode(node,"Program");};var loopLabel={kind:"loop"},switchLabel={kind:"switch"}; // Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.
pp.parseStatement = function(declaration,topLevel){var starttype=this.type,node=this.startNode(); // Most types of statements are recognized by the keyword they
// start with. Many are trivial to parse, some require a bit of
// complexity.
switch(starttype){case _tokentype.types._break:case _tokentype.types._continue:return this.parseBreakContinueStatement(node,starttype.keyword);case _tokentype.types._debugger:return this.parseDebuggerStatement(node);case _tokentype.types._do:return this.parseDoStatement(node);case _tokentype.types._for:return this.parseForStatement(node);case _tokentype.types._function:if(!declaration && this.options.ecmaVersion >= 6)this.unexpected();return this.parseFunctionStatement(node);case _tokentype.types._class:if(!declaration)this.unexpected();return this.parseClass(node,true);case _tokentype.types._if:return this.parseIfStatement(node);case _tokentype.types._return:return this.parseReturnStatement(node);case _tokentype.types._switch:return this.parseSwitchStatement(node);case _tokentype.types._throw:return this.parseThrowStatement(node);case _tokentype.types._try:return this.parseTryStatement(node);case _tokentype.types._let:case _tokentype.types._const:if(!declaration)this.unexpected(); // NOTE: falls through to _var
case _tokentype.types._var:return this.parseVarStatement(node,starttype);case _tokentype.types._while:return this.parseWhileStatement(node);case _tokentype.types._with:return this.parseWithStatement(node);case _tokentype.types.braceL:return this.parseBlock();case _tokentype.types.semi:return this.parseEmptyStatement(node);case _tokentype.types._export:case _tokentype.types._import:if(!this.options.allowImportExportEverywhere){if(!topLevel)this.raise(this.start,"'import' and 'export' may only appear at the top level");if(!this.inModule)this.raise(this.start,"'import' and 'export' may appear only with 'sourceType: module'");}return starttype === _tokentype.types._import?this.parseImport(node):this.parseExport(node); // If the statement does not start with a statement keyword or a
// brace, it's an ExpressionStatement or LabeledStatement. We
// simply start parsing an expression, and afterwards, if the
// next token is a colon and the expression was a simple
// Identifier node, we switch to interpreting it as a label.
default:var maybeName=this.value,expr=this.parseExpression();if(starttype === _tokentype.types.name && expr.type === "Identifier" && this.eat(_tokentype.types.colon))return this.parseLabeledStatement(node,maybeName,expr);else return this.parseExpressionStatement(node,expr);}};pp.parseBreakContinueStatement = function(node,keyword){var isBreak=keyword == "break";this.next();if(this.eat(_tokentype.types.semi) || this.insertSemicolon())node.label = null;else if(this.type !== _tokentype.types.name)this.unexpected();else {node.label = this.parseIdent();this.semicolon();} // Verify that there is an actual destination to break or
// continue to.
for(var i=0;i < this.labels.length;++i) {var lab=this.labels[i];if(node.label == null || lab.name === node.label.name){if(lab.kind != null && (isBreak || lab.kind === "loop"))break;if(node.label && isBreak)break;}}if(i === this.labels.length)this.raise(node.start,"Unsyntactic " + keyword);return this.finishNode(node,isBreak?"BreakStatement":"ContinueStatement");};pp.parseDebuggerStatement = function(node){this.next();this.semicolon();return this.finishNode(node,"DebuggerStatement");};pp.parseDoStatement = function(node){this.next();this.labels.push(loopLabel);node.body = this.parseStatement(false);this.labels.pop();this.expect(_tokentype.types._while);node.test = this.parseParenExpression();if(this.options.ecmaVersion >= 6)this.eat(_tokentype.types.semi);else this.semicolon();return this.finishNode(node,"DoWhileStatement");}; // Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.
pp.parseForStatement = function(node){this.next();this.labels.push(loopLabel);this.expect(_tokentype.types.parenL);if(this.type === _tokentype.types.semi)return this.parseFor(node,null);if(this.type === _tokentype.types._var || this.type === _tokentype.types._let || this.type === _tokentype.types._const){var _init=this.startNode(),varKind=this.type;this.next();this.parseVar(_init,true,varKind);this.finishNode(_init,"VariableDeclaration");if((this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && _init.declarations.length === 1 && !(varKind !== _tokentype.types._var && _init.declarations[0].init))return this.parseForIn(node,_init);return this.parseFor(node,_init);}var refShorthandDefaultPos={start:0};var init=this.parseExpression(true,refShorthandDefaultPos);if(this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of")){this.toAssignable(init);this.checkLVal(init);return this.parseForIn(node,init);}else if(refShorthandDefaultPos.start){this.unexpected(refShorthandDefaultPos.start);}return this.parseFor(node,init);};pp.parseFunctionStatement = function(node){this.next();return this.parseFunction(node,true);};pp.parseIfStatement = function(node){this.next();node.test = this.parseParenExpression();node.consequent = this.parseStatement(false);node.alternate = this.eat(_tokentype.types._else)?this.parseStatement(false):null;return this.finishNode(node,"IfStatement");};pp.parseReturnStatement = function(node){if(!this.inFunction && !this.options.allowReturnOutsideFunction)this.raise(this.start,"'return' outside of function");this.next(); // In `return` (and `break`/`continue`), the keywords with
// optional arguments, we eagerly look for a semicolon or the
// possibility to insert one.
if(this.eat(_tokentype.types.semi) || this.insertSemicolon())node.argument = null;else {node.argument = this.parseExpression();this.semicolon();}return this.finishNode(node,"ReturnStatement");};pp.parseSwitchStatement = function(node){this.next();node.discriminant = this.parseParenExpression();node.cases = [];this.expect(_tokentype.types.braceL);this.labels.push(switchLabel); // Statements under must be grouped (by label) in SwitchCase
// nodes. `cur` is used to keep the node that we are currently
// adding statements to.
for(var cur,sawDefault=false;this.type != _tokentype.types.braceR;) {if(this.type === _tokentype.types._case || this.type === _tokentype.types._default){var isCase=this.type === _tokentype.types._case;if(cur)this.finishNode(cur,"SwitchCase");node.cases.push(cur = this.startNode());cur.consequent = [];this.next();if(isCase){cur.test = this.parseExpression();}else {if(sawDefault)this.raise(this.lastTokStart,"Multiple default clauses");sawDefault = true;cur.test = null;}this.expect(_tokentype.types.colon);}else {if(!cur)this.unexpected();cur.consequent.push(this.parseStatement(true));}}if(cur)this.finishNode(cur,"SwitchCase");this.next(); // Closing brace
this.labels.pop();return this.finishNode(node,"SwitchStatement");};pp.parseThrowStatement = function(node){this.next();if(_whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.start)))this.raise(this.lastTokEnd,"Illegal newline after throw");node.argument = this.parseExpression();this.semicolon();return this.finishNode(node,"ThrowStatement");}; // Reused empty array added for node fields that are always empty.
var empty=[];pp.parseTryStatement = function(node){this.next();node.block = this.parseBlock();node.handler = null;if(this.type === _tokentype.types._catch){var clause=this.startNode();this.next();this.expect(_tokentype.types.parenL);clause.param = this.parseBindingAtom();this.checkLVal(clause.param,true);this.expect(_tokentype.types.parenR);clause.guard = null;clause.body = this.parseBlock();node.handler = this.finishNode(clause,"CatchClause");}node.guardedHandlers = empty;node.finalizer = this.eat(_tokentype.types._finally)?this.parseBlock():null;if(!node.handler && !node.finalizer)this.raise(node.start,"Missing catch or finally clause");return this.finishNode(node,"TryStatement");};pp.parseVarStatement = function(node,kind){this.next();this.parseVar(node,false,kind);this.semicolon();return this.finishNode(node,"VariableDeclaration");};pp.parseWhileStatement = function(node){this.next();node.test = this.parseParenExpression();this.labels.push(loopLabel);node.body = this.parseStatement(false);this.labels.pop();return this.finishNode(node,"WhileStatement");};pp.parseWithStatement = function(node){if(this.strict)this.raise(this.start,"'with' in strict mode");this.next();node.object = this.parseParenExpression();node.body = this.parseStatement(false);return this.finishNode(node,"WithStatement");};pp.parseEmptyStatement = function(node){this.next();return this.finishNode(node,"EmptyStatement");};pp.parseLabeledStatement = function(node,maybeName,expr){for(var i=0;i < this.labels.length;++i) {if(this.labels[i].name === maybeName)this.raise(expr.start,"Label '" + maybeName + "' is already declared");}var kind=this.type.isLoop?"loop":this.type === _tokentype.types._switch?"switch":null;for(var i=this.labels.length - 1;i >= 0;i--) {var label=this.labels[i];if(label.statementStart == node.start){label.statementStart = this.start;label.kind = kind;}else break;}this.labels.push({name:maybeName,kind:kind,statementStart:this.start});node.body = this.parseStatement(true);this.labels.pop();node.label = expr;return this.finishNode(node,"LabeledStatement");};pp.parseExpressionStatement = function(node,expr){node.expression = expr;this.semicolon();return this.finishNode(node,"ExpressionStatement");}; // Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).
pp.parseBlock = function(allowStrict){var node=this.startNode(),first=true,oldStrict=undefined;node.body = [];this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {var stmt=this.parseStatement(true);node.body.push(stmt);if(first && allowStrict && this.isUseStrict(stmt)){oldStrict = this.strict;this.setStrict(this.strict = true);}first = false;}if(oldStrict === false)this.setStrict(false);return this.finishNode(node,"BlockStatement");}; // Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.
pp.parseFor = function(node,init){node.init = init;this.expect(_tokentype.types.semi);node.test = this.type === _tokentype.types.semi?null:this.parseExpression();this.expect(_tokentype.types.semi);node.update = this.type === _tokentype.types.parenR?null:this.parseExpression();this.expect(_tokentype.types.parenR);node.body = this.parseStatement(false);this.labels.pop();return this.finishNode(node,"ForStatement");}; // Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.
pp.parseForIn = function(node,init){var type=this.type === _tokentype.types._in?"ForInStatement":"ForOfStatement";this.next();node.left = init;node.right = this.parseExpression();this.expect(_tokentype.types.parenR);node.body = this.parseStatement(false);this.labels.pop();return this.finishNode(node,type);}; // Parse a list of variable declarations.
pp.parseVar = function(node,isFor,kind){node.declarations = [];node.kind = kind.keyword;for(;;) {var decl=this.startNode();this.parseVarId(decl);if(this.eat(_tokentype.types.eq)){decl.init = this.parseMaybeAssign(isFor);}else if(kind === _tokentype.types._const && !(this.type === _tokentype.types._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))){this.unexpected();}else if(decl.id.type != "Identifier" && !(isFor && (this.type === _tokentype.types._in || this.isContextual("of")))){this.raise(this.lastTokEnd,"Complex binding patterns require an initialization value");}else {decl.init = null;}node.declarations.push(this.finishNode(decl,"VariableDeclarator"));if(!this.eat(_tokentype.types.comma))break;}return node;};pp.parseVarId = function(decl){decl.id = this.parseBindingAtom();this.checkLVal(decl.id,true);}; // Parse a function declaration or literal (depending on the
// `isStatement` parameter).
pp.parseFunction = function(node,isStatement,allowExpressionBody){this.initFunction(node);if(this.options.ecmaVersion >= 6)node.generator = this.eat(_tokentype.types.star);if(isStatement || this.type === _tokentype.types.name)node.id = this.parseIdent();this.parseFunctionParams(node);this.parseFunctionBody(node,allowExpressionBody);return this.finishNode(node,isStatement?"FunctionDeclaration":"FunctionExpression");};pp.parseFunctionParams = function(node){this.expect(_tokentype.types.parenL);node.params = this.parseBindingList(_tokentype.types.parenR,false,false);}; // Parse a class declaration or literal (depending on the
// `isStatement` parameter).
pp.parseClass = function(node,isStatement){this.next();this.parseClassId(node,isStatement);this.parseClassSuper(node);var classBody=this.startNode();var hadConstructor=false;classBody.body = [];this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {if(this.eat(_tokentype.types.semi))continue;var method=this.startNode();var isGenerator=this.eat(_tokentype.types.star);var isMaybeStatic=this.type === _tokentype.types.name && this.value === "static";this.parsePropertyName(method);method["static"] = isMaybeStatic && this.type !== _tokentype.types.parenL;if(method["static"]){if(isGenerator)this.unexpected();isGenerator = this.eat(_tokentype.types.star);this.parsePropertyName(method);}method.kind = "method";var isGetSet=false;if(!method.computed){var key=method.key;if(!isGenerator && key.type === "Identifier" && this.type !== _tokentype.types.parenL && (key.name === "get" || key.name === "set")){isGetSet = true;method.kind = key.name;key = this.parsePropertyName(method);}if(!method["static"] && (key.type === "Identifier" && key.name === "constructor" || key.type === "Literal" && key.value === "constructor")){if(hadConstructor)this.raise(key.start,"Duplicate constructor in the same class");if(isGetSet)this.raise(key.start,"Constructor can't have get/set modifier");if(isGenerator)this.raise(key.start,"Constructor can't be a generator");method.kind = "constructor";hadConstructor = true;}}this.parseClassMethod(classBody,method,isGenerator);if(isGetSet){var paramCount=method.kind === "get"?0:1;if(method.value.params.length !== paramCount){var start=method.value.start;if(method.kind === "get")this.raise(start,"getter should have no params");else this.raise(start,"setter should have exactly one param");}}}node.body = this.finishNode(classBody,"ClassBody");return this.finishNode(node,isStatement?"ClassDeclaration":"ClassExpression");};pp.parseClassMethod = function(classBody,method,isGenerator){method.value = this.parseMethod(isGenerator);classBody.body.push(this.finishNode(method,"MethodDefinition"));};pp.parseClassId = function(node,isStatement){node.id = this.type === _tokentype.types.name?this.parseIdent():isStatement?this.unexpected():null;};pp.parseClassSuper = function(node){node.superClass = this.eat(_tokentype.types._extends)?this.parseExprSubscripts():null;}; // Parses module export declaration.
pp.parseExport = function(node){this.next(); // export * from '...'
if(this.eat(_tokentype.types.star)){this.expectContextual("from");node.source = this.type === _tokentype.types.string?this.parseExprAtom():this.unexpected();this.semicolon();return this.finishNode(node,"ExportAllDeclaration");}if(this.eat(_tokentype.types._default)){ // export default ...
var expr=this.parseMaybeAssign();var needsSemi=true;if(expr.type == "FunctionExpression" || expr.type == "ClassExpression"){needsSemi = false;if(expr.id){expr.type = expr.type == "FunctionExpression"?"FunctionDeclaration":"ClassDeclaration";}}node.declaration = expr;if(needsSemi)this.semicolon();return this.finishNode(node,"ExportDefaultDeclaration");} // export var|const|let|function|class ...
if(this.shouldParseExportStatement()){node.declaration = this.parseStatement(true);node.specifiers = [];node.source = null;}else { // export { x, y as z } [from '...']
node.declaration = null;node.specifiers = this.parseExportSpecifiers();if(this.eatContextual("from")){node.source = this.type === _tokentype.types.string?this.parseExprAtom():this.unexpected();}else {node.source = null;}this.semicolon();}return this.finishNode(node,"ExportNamedDeclaration");};pp.shouldParseExportStatement = function(){return this.type.keyword;}; // Parses a comma-separated list of module exports.
pp.parseExportSpecifiers = function(){var nodes=[],first=true; // export { x, y as z } [from '...']
this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {if(!first){this.expect(_tokentype.types.comma);if(this.afterTrailingComma(_tokentype.types.braceR))break;}else first = false;var node=this.startNode();node.local = this.parseIdent(this.type === _tokentype.types._default);node.exported = this.eatContextual("as")?this.parseIdent(true):node.local;nodes.push(this.finishNode(node,"ExportSpecifier"));}return nodes;}; // Parses import declaration.
pp.parseImport = function(node){this.next(); // import '...'
if(this.type === _tokentype.types.string){node.specifiers = empty;node.source = this.parseExprAtom();}else {node.specifiers = this.parseImportSpecifiers();this.expectContextual("from");node.source = this.type === _tokentype.types.string?this.parseExprAtom():this.unexpected();}this.semicolon();return this.finishNode(node,"ImportDeclaration");}; // Parses a comma-separated list of module imports.
pp.parseImportSpecifiers = function(){var nodes=[],first=true;if(this.type === _tokentype.types.name){ // import defaultObj, { x, y as z } from '...'
var node=this.startNode();node.local = this.parseIdent();this.checkLVal(node.local,true);nodes.push(this.finishNode(node,"ImportDefaultSpecifier"));if(!this.eat(_tokentype.types.comma))return nodes;}if(this.type === _tokentype.types.star){var node=this.startNode();this.next();this.expectContextual("as");node.local = this.parseIdent();this.checkLVal(node.local,true);nodes.push(this.finishNode(node,"ImportNamespaceSpecifier"));return nodes;}this.expect(_tokentype.types.braceL);while(!this.eat(_tokentype.types.braceR)) {if(!first){this.expect(_tokentype.types.comma);if(this.afterTrailingComma(_tokentype.types.braceR))break;}else first = false;var node=this.startNode();node.imported = this.parseIdent(true);node.local = this.eatContextual("as")?this.parseIdent():node.imported;this.checkLVal(node.local,true);nodes.push(this.finishNode(node,"ImportSpecifier"));}return nodes;};},{"./state":10,"./tokentype":14,"./whitespace":16}],12:[function(_dereq_,module,exports){ // The algorithm used to determine whether a regexp can appear at a
// given point in the program is loosely based on sweet.js' approach.
// See https://github.com/mozilla/sweet.js/wiki/design
"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _state=_dereq_("./state");var _tokentype=_dereq_("./tokentype");var _whitespace=_dereq_("./whitespace");var TokContext=function TokContext(token,isExpr,preserveSpace,override){_classCallCheck(this,TokContext);this.token = token;this.isExpr = !!isExpr;this.preserveSpace = !!preserveSpace;this.override = override;};exports.TokContext = TokContext;var types={b_stat:new TokContext("{",false),b_expr:new TokContext("{",true),b_tmpl:new TokContext("${",true),p_stat:new TokContext("(",false),p_expr:new TokContext("(",true),q_tmpl:new TokContext("`",true,true,function(p){return p.readTmplToken();}),f_expr:new TokContext("function",true)};exports.types = types;var pp=_state.Parser.prototype;pp.initialContext = function(){return [types.b_stat];};pp.braceIsBlock = function(prevType){if(prevType === _tokentype.types.colon){var _parent=this.curContext();if(_parent === types.b_stat || _parent === types.b_expr)return !_parent.isExpr;}if(prevType === _tokentype.types._return)return _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.start));if(prevType === _tokentype.types._else || prevType === _tokentype.types.semi || prevType === _tokentype.types.eof || prevType === _tokentype.types.parenR)return true;if(prevType == _tokentype.types.braceL)return this.curContext() === types.b_stat;return !this.exprAllowed;};pp.updateContext = function(prevType){var update=undefined,type=this.type;if(type.keyword && prevType == _tokentype.types.dot)this.exprAllowed = false;else if(update = type.updateContext)update.call(this,prevType);else this.exprAllowed = type.beforeExpr;}; // Token-specific context update code
_tokentype.types.parenR.updateContext = _tokentype.types.braceR.updateContext = function(){if(this.context.length == 1){this.exprAllowed = true;return;}var out=this.context.pop();if(out === types.b_stat && this.curContext() === types.f_expr){this.context.pop();this.exprAllowed = false;}else if(out === types.b_tmpl){this.exprAllowed = true;}else {this.exprAllowed = !out.isExpr;}};_tokentype.types.braceL.updateContext = function(prevType){this.context.push(this.braceIsBlock(prevType)?types.b_stat:types.b_expr);this.exprAllowed = true;};_tokentype.types.dollarBraceL.updateContext = function(){this.context.push(types.b_tmpl);this.exprAllowed = true;};_tokentype.types.parenL.updateContext = function(prevType){var statementParens=prevType === _tokentype.types._if || prevType === _tokentype.types._for || prevType === _tokentype.types._with || prevType === _tokentype.types._while;this.context.push(statementParens?types.p_stat:types.p_expr);this.exprAllowed = true;};_tokentype.types.incDec.updateContext = function(){ // tokExprAllowed stays unchanged
};_tokentype.types._function.updateContext = function(){if(this.curContext() !== types.b_stat)this.context.push(types.f_expr);this.exprAllowed = false;};_tokentype.types.backQuote.updateContext = function(){if(this.curContext() === types.q_tmpl)this.context.pop();else this.context.push(types.q_tmpl);this.exprAllowed = false;};},{"./state":10,"./tokentype":14,"./whitespace":16}],13:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var _identifier=_dereq_("./identifier");var _tokentype=_dereq_("./tokentype");var _state=_dereq_("./state");var _locutil=_dereq_("./locutil");var _whitespace=_dereq_("./whitespace"); // Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.
var Token=function Token(p){_classCallCheck(this,Token);this.type = p.type;this.value = p.value;this.start = p.start;this.end = p.end;if(p.options.locations)this.loc = new _locutil.SourceLocation(p,p.startLoc,p.endLoc);if(p.options.ranges)this.range = [p.start,p.end];} // ## Tokenizer
;exports.Token = Token;var pp=_state.Parser.prototype; // Are we running under Rhino?
var isRhino=typeof Packages == "object" && Object.prototype.toString.call(Packages) == "[object JavaPackage]"; // Move to the next token
pp.next = function(){if(this.options.onToken)this.options.onToken(new Token(this));this.lastTokEnd = this.end;this.lastTokStart = this.start;this.lastTokEndLoc = this.endLoc;this.lastTokStartLoc = this.startLoc;this.nextToken();};pp.getToken = function(){this.next();return new Token(this);}; // If we're in an ES6 environment, make parsers iterable
if(typeof Symbol !== "undefined")pp[Symbol.iterator] = function(){var self=this;return {next:function next(){var token=self.getToken();return {done:token.type === _tokentype.types.eof,value:token};}};}; // Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).
pp.setStrict = function(strict){this.strict = strict;if(this.type !== _tokentype.types.num && this.type !== _tokentype.types.string)return;this.pos = this.start;if(this.options.locations){while(this.pos < this.lineStart) {this.lineStart = this.input.lastIndexOf("\n",this.lineStart - 2) + 1;--this.curLine;}}this.nextToken();};pp.curContext = function(){return this.context[this.context.length - 1];}; // Read a single token, updating the parser object's token-related
// properties.
pp.nextToken = function(){var curContext=this.curContext();if(!curContext || !curContext.preserveSpace)this.skipSpace();this.start = this.pos;if(this.options.locations)this.startLoc = this.curPosition();if(this.pos >= this.input.length)return this.finishToken(_tokentype.types.eof);if(curContext.override)return curContext.override(this);else this.readToken(this.fullCharCodeAtPos());};pp.readToken = function(code){ // Identifier or keyword. '\uXXXX' sequences are allowed in
// identifiers, so '\' also dispatches to that.
if(_identifier.isIdentifierStart(code,this.options.ecmaVersion >= 6) || code === 92 /* '\' */)return this.readWord();return this.getTokenFromCode(code);};pp.fullCharCodeAtPos = function(){var code=this.input.charCodeAt(this.pos);if(code <= 0xd7ff || code >= 0xe000)return code;var next=this.input.charCodeAt(this.pos + 1);return (code << 10) + next - 0x35fdc00;};pp.skipBlockComment = function(){var startLoc=this.options.onComment && this.curPosition();var start=this.pos,end=this.input.indexOf("*/",this.pos += 2);if(end === -1)this.raise(this.pos - 2,"Unterminated comment");this.pos = end + 2;if(this.options.locations){_whitespace.lineBreakG.lastIndex = start;var match=undefined;while((match = _whitespace.lineBreakG.exec(this.input)) && match.index < this.pos) {++this.curLine;this.lineStart = match.index + match[0].length;}}if(this.options.onComment)this.options.onComment(true,this.input.slice(start + 2,end),start,this.pos,startLoc,this.curPosition());};pp.skipLineComment = function(startSkip){var start=this.pos;var startLoc=this.options.onComment && this.curPosition();var ch=this.input.charCodeAt(this.pos += startSkip);while(this.pos < this.input.length && ch !== 10 && ch !== 13 && ch !== 8232 && ch !== 8233) {++this.pos;ch = this.input.charCodeAt(this.pos);}if(this.options.onComment)this.options.onComment(false,this.input.slice(start + startSkip,this.pos),start,this.pos,startLoc,this.curPosition());}; // Called at the start of the parse and after every token. Skips
// whitespace and comments, and.
pp.skipSpace = function(){loop: while(this.pos < this.input.length) {var ch=this.input.charCodeAt(this.pos);switch(ch){case 32:case 160: // ' '
++this.pos;break;case 13:if(this.input.charCodeAt(this.pos + 1) === 10){++this.pos;}case 10:case 8232:case 8233:++this.pos;if(this.options.locations){++this.curLine;this.lineStart = this.pos;}break;case 47: // '/'
switch(this.input.charCodeAt(this.pos + 1)){case 42: // '*'
this.skipBlockComment();break;case 47:this.skipLineComment(2);break;default:break loop;}break;default:if(ch > 8 && ch < 14 || ch >= 5760 && _whitespace.nonASCIIwhitespace.test(String.fromCharCode(ch))){++this.pos;}else {break loop;}}}}; // Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.
pp.finishToken = function(type,val){this.end = this.pos;if(this.options.locations)this.endLoc = this.curPosition();var prevType=this.type;this.type = type;this.value = val;this.updateContext(prevType);}; // ### Token reading
// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
pp.readToken_dot = function(){var next=this.input.charCodeAt(this.pos + 1);if(next >= 48 && next <= 57)return this.readNumber(true);var next2=this.input.charCodeAt(this.pos + 2);if(this.options.ecmaVersion >= 6 && next === 46 && next2 === 46){ // 46 = dot '.'
this.pos += 3;return this.finishToken(_tokentype.types.ellipsis);}else {++this.pos;return this.finishToken(_tokentype.types.dot);}};pp.readToken_slash = function(){ // '/'
var next=this.input.charCodeAt(this.pos + 1);if(this.exprAllowed){++this.pos;return this.readRegexp();}if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(_tokentype.types.slash,1);};pp.readToken_mult_modulo = function(code){ // '%*'
var next=this.input.charCodeAt(this.pos + 1);if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(code === 42?_tokentype.types.star:_tokentype.types.modulo,1);};pp.readToken_pipe_amp = function(code){ // '|&'
var next=this.input.charCodeAt(this.pos + 1);if(next === code)return this.finishOp(code === 124?_tokentype.types.logicalOR:_tokentype.types.logicalAND,2);if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(code === 124?_tokentype.types.bitwiseOR:_tokentype.types.bitwiseAND,1);};pp.readToken_caret = function(){ // '^'
var next=this.input.charCodeAt(this.pos + 1);if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(_tokentype.types.bitwiseXOR,1);};pp.readToken_plus_min = function(code){ // '+-'
var next=this.input.charCodeAt(this.pos + 1);if(next === code){if(next == 45 && this.input.charCodeAt(this.pos + 2) == 62 && _whitespace.lineBreak.test(this.input.slice(this.lastTokEnd,this.pos))){ // A `-->` line comment
this.skipLineComment(3);this.skipSpace();return this.nextToken();}return this.finishOp(_tokentype.types.incDec,2);}if(next === 61)return this.finishOp(_tokentype.types.assign,2);return this.finishOp(_tokentype.types.plusMin,1);};pp.readToken_lt_gt = function(code){ // '<>'
var next=this.input.charCodeAt(this.pos + 1);var size=1;if(next === code){size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62?3:2;if(this.input.charCodeAt(this.pos + size) === 61)return this.finishOp(_tokentype.types.assign,size + 1);return this.finishOp(_tokentype.types.bitShift,size);}if(next == 33 && code == 60 && this.input.charCodeAt(this.pos + 2) == 45 && this.input.charCodeAt(this.pos + 3) == 45){if(this.inModule)this.unexpected(); // `<!--`, an XML-style comment that should be interpreted as a line comment
this.skipLineComment(4);this.skipSpace();return this.nextToken();}if(next === 61)size = this.input.charCodeAt(this.pos + 2) === 61?3:2;return this.finishOp(_tokentype.types.relational,size);};pp.readToken_eq_excl = function(code){ // '=!'
var next=this.input.charCodeAt(this.pos + 1);if(next === 61)return this.finishOp(_tokentype.types.equality,this.input.charCodeAt(this.pos + 2) === 61?3:2);if(code === 61 && next === 62 && this.options.ecmaVersion >= 6){ // '=>'
this.pos += 2;return this.finishToken(_tokentype.types.arrow);}return this.finishOp(code === 61?_tokentype.types.eq:_tokentype.types.prefix,1);};pp.getTokenFromCode = function(code){switch(code){ // The interpretation of a dot depends on whether it is followed
// by a digit or another two dots.
case 46: // '.'
return this.readToken_dot(); // Punctuation tokens.
case 40:++this.pos;return this.finishToken(_tokentype.types.parenL);case 41:++this.pos;return this.finishToken(_tokentype.types.parenR);case 59:++this.pos;return this.finishToken(_tokentype.types.semi);case 44:++this.pos;return this.finishToken(_tokentype.types.comma);case 91:++this.pos;return this.finishToken(_tokentype.types.bracketL);case 93:++this.pos;return this.finishToken(_tokentype.types.bracketR);case 123:++this.pos;return this.finishToken(_tokentype.types.braceL);case 125:++this.pos;return this.finishToken(_tokentype.types.braceR);case 58:++this.pos;return this.finishToken(_tokentype.types.colon);case 63:++this.pos;return this.finishToken(_tokentype.types.question);case 96: // '`'
if(this.options.ecmaVersion < 6)break;++this.pos;return this.finishToken(_tokentype.types.backQuote);case 48: // '0'
var next=this.input.charCodeAt(this.pos + 1);if(next === 120 || next === 88)return this.readRadixNumber(16); // '0x', '0X' - hex number
if(this.options.ecmaVersion >= 6){if(next === 111 || next === 79)return this.readRadixNumber(8); // '0o', '0O' - octal number
if(next === 98 || next === 66)return this.readRadixNumber(2); // '0b', '0B' - binary number
} // Anything else beginning with a digit is an integer, octal
// number, or float.
case 49:case 50:case 51:case 52:case 53:case 54:case 55:case 56:case 57: // 1-9
return this.readNumber(false); // Quotes produce strings.
case 34:case 39: // '"', "'"
return this.readString(code); // Operators are parsed inline in tiny state machines. '=' (61) is
// often referred to. `finishOp` simply skips the amount of
// characters it is given as second argument, and returns a token
// of the type given by its first argument.
case 47: // '/'
return this.readToken_slash();case 37:case 42: // '%*'
return this.readToken_mult_modulo(code);case 124:case 38: // '|&'
return this.readToken_pipe_amp(code);case 94: // '^'
return this.readToken_caret();case 43:case 45: // '+-'
return this.readToken_plus_min(code);case 60:case 62: // '<>'
return this.readToken_lt_gt(code);case 61:case 33: // '=!'
return this.readToken_eq_excl(code);case 126: // '~'
return this.finishOp(_tokentype.types.prefix,1);}this.raise(this.pos,"Unexpected character '" + codePointToString(code) + "'");};pp.finishOp = function(type,size){var str=this.input.slice(this.pos,this.pos + size);this.pos += size;return this.finishToken(type,str);}; // Parse a regular expression. Some context-awareness is necessary,
// since a '/' inside a '[]' set does not end the expression.
function tryCreateRegexp(src,flags,throwErrorAt){try{return new RegExp(src,flags);}catch(e) {if(throwErrorAt !== undefined){if(e instanceof SyntaxError)this.raise(throwErrorAt,"Error parsing regular expression: " + e.message);this.raise(e);}}}var regexpUnicodeSupport=!!tryCreateRegexp("￿","u");pp.readRegexp = function(){var _this=this;var escaped=undefined,inClass=undefined,start=this.pos;for(;;) {if(this.pos >= this.input.length)this.raise(start,"Unterminated regular expression");var ch=this.input.charAt(this.pos);if(_whitespace.lineBreak.test(ch))this.raise(start,"Unterminated regular expression");if(!escaped){if(ch === "[")inClass = true;else if(ch === "]" && inClass)inClass = false;else if(ch === "/" && !inClass)break;escaped = ch === "\\";}else escaped = false;++this.pos;}var content=this.input.slice(start,this.pos);++this.pos; // Need to use `readWord1` because '\uXXXX' sequences are allowed
// here (don't ask).
var mods=this.readWord1();var tmp=content;if(mods){var validFlags=/^[gmsiy]*$/;if(this.options.ecmaVersion >= 6)validFlags = /^[gmsiyu]*$/;if(!validFlags.test(mods))this.raise(start,"Invalid regular expression flag");if(mods.indexOf('u') >= 0 && !regexpUnicodeSupport){ // Replace each astral symbol and every Unicode escape sequence that
// possibly represents an astral symbol or a paired surrogate with a
// single ASCII symbol to avoid throwing on regular expressions that
// are only valid in combination with the `/u` flag.
// Note: replacing with the ASCII symbol `x` might cause false
// negatives in unlikely scenarios. For example, `[\u{61}-b]` is a
// perfectly valid pattern that is equivalent to `[a-b]`, but it would
// be replaced by `[x-b]` which throws an error.
tmp = tmp.replace(/\\u\{([0-9a-fA-F]+)\}/g,function(match,code,offset){code = Number("0x" + code);if(code > 0x10FFFF)_this.raise(start + offset + 3,"Code point out of bounds");return "x";});tmp = tmp.replace(/\\u([a-fA-F0-9]{4})|[\uD800-\uDBFF][\uDC00-\uDFFF]/g,"x");}} // Detect invalid regular expressions.
var value=null; // Rhino's regular expression parser is flaky and throws uncatchable exceptions,
// so don't do detection if we are running under Rhino
if(!isRhino){tryCreateRegexp(tmp,undefined,start); // Get a regular expression object for this pattern-flag pair, or `null` in
// case the current environment doesn't support the flags it uses.
value = tryCreateRegexp(content,mods);}return this.finishToken(_tokentype.types.regexp,{pattern:content,flags:mods,value:value});}; // Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.
pp.readInt = function(radix,len){var start=this.pos,total=0;for(var i=0,e=len == null?Infinity:len;i < e;++i) {var code=this.input.charCodeAt(this.pos),val=undefined;if(code >= 97)val = code - 97 + 10; // a
else if(code >= 65)val = code - 65 + 10; // A
else if(code >= 48 && code <= 57)val = code - 48; // 0-9
else val = Infinity;if(val >= radix)break;++this.pos;total = total * radix + val;}if(this.pos === start || len != null && this.pos - start !== len)return null;return total;};pp.readRadixNumber = function(radix){this.pos += 2; // 0x
var val=this.readInt(radix);if(val == null)this.raise(this.start + 2,"Expected number in radix " + radix);if(_identifier.isIdentifierStart(this.fullCharCodeAtPos()))this.raise(this.pos,"Identifier directly after number");return this.finishToken(_tokentype.types.num,val);}; // Read an integer, octal integer, or floating-point number.
pp.readNumber = function(startsWithDot){var start=this.pos,isFloat=false,octal=this.input.charCodeAt(this.pos) === 48;if(!startsWithDot && this.readInt(10) === null)this.raise(start,"Invalid number");var next=this.input.charCodeAt(this.pos);if(next === 46){ // '.'
++this.pos;this.readInt(10);isFloat = true;next = this.input.charCodeAt(this.pos);}if(next === 69 || next === 101){ // 'eE'
next = this.input.charCodeAt(++this.pos);if(next === 43 || next === 45)++this.pos; // '+-'
if(this.readInt(10) === null)this.raise(start,"Invalid number");isFloat = true;}if(_identifier.isIdentifierStart(this.fullCharCodeAtPos()))this.raise(this.pos,"Identifier directly after number");var str=this.input.slice(start,this.pos),val=undefined;if(isFloat)val = parseFloat(str);else if(!octal || str.length === 1)val = parseInt(str,10);else if(/[89]/.test(str) || this.strict)this.raise(start,"Invalid number");else val = parseInt(str,8);return this.finishToken(_tokentype.types.num,val);}; // Read a string value, interpreting backslash-escapes.
pp.readCodePoint = function(){var ch=this.input.charCodeAt(this.pos),code=undefined;if(ch === 123){if(this.options.ecmaVersion < 6)this.unexpected();var codePos=++this.pos;code = this.readHexChar(this.input.indexOf('}',this.pos) - this.pos);++this.pos;if(code > 0x10FFFF)this.raise(codePos,"Code point out of bounds");}else {code = this.readHexChar(4);}return code;};function codePointToString(code){ // UTF-16 Decoding
if(code <= 0xFFFF)return String.fromCharCode(code);code -= 0x10000;return String.fromCharCode((code >> 10) + 0xD800,(code & 1023) + 0xDC00);}pp.readString = function(quote){var out="",chunkStart=++this.pos;for(;;) {if(this.pos >= this.input.length)this.raise(this.start,"Unterminated string constant");var ch=this.input.charCodeAt(this.pos);if(ch === quote)break;if(ch === 92){ // '\'
out += this.input.slice(chunkStart,this.pos);out += this.readEscapedChar(false);chunkStart = this.pos;}else {if(_whitespace.isNewLine(ch))this.raise(this.start,"Unterminated string constant");++this.pos;}}out += this.input.slice(chunkStart,this.pos++);return this.finishToken(_tokentype.types.string,out);}; // Reads template string tokens.
pp.readTmplToken = function(){var out="",chunkStart=this.pos;for(;;) {if(this.pos >= this.input.length)this.raise(this.start,"Unterminated template");var ch=this.input.charCodeAt(this.pos);if(ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123){ // '`', '${'
if(this.pos === this.start && this.type === _tokentype.types.template){if(ch === 36){this.pos += 2;return this.finishToken(_tokentype.types.dollarBraceL);}else {++this.pos;return this.finishToken(_tokentype.types.backQuote);}}out += this.input.slice(chunkStart,this.pos);return this.finishToken(_tokentype.types.template,out);}if(ch === 92){ // '\'
out += this.input.slice(chunkStart,this.pos);out += this.readEscapedChar(true);chunkStart = this.pos;}else if(_whitespace.isNewLine(ch)){out += this.input.slice(chunkStart,this.pos);++this.pos;switch(ch){case 13:if(this.input.charCodeAt(this.pos) === 10)++this.pos;case 10:out += "\n";break;default:out += String.fromCharCode(ch);break;}if(this.options.locations){++this.curLine;this.lineStart = this.pos;}chunkStart = this.pos;}else {++this.pos;}}}; // Used to read escaped characters
pp.readEscapedChar = function(inTemplate){var ch=this.input.charCodeAt(++this.pos);++this.pos;switch(ch){case 110:return "\n"; // 'n' -> '\n'
case 114:return "\r"; // 'r' -> '\r'
case 120:return String.fromCharCode(this.readHexChar(2)); // 'x'
case 117:return codePointToString(this.readCodePoint()); // 'u'
case 116:return "\t"; // 't' -> '\t'
case 98:return "\b"; // 'b' -> '\b'
case 118:return "\u000b"; // 'v' -> '\u000b'
case 102:return "\f"; // 'f' -> '\f'
case 13:if(this.input.charCodeAt(this.pos) === 10)++this.pos; // '\r\n'
case 10: // ' \n'
if(this.options.locations){this.lineStart = this.pos;++this.curLine;}return "";default:if(ch >= 48 && ch <= 55){var octalStr=this.input.substr(this.pos - 1,3).match(/^[0-7]+/)[0];var octal=parseInt(octalStr,8);if(octal > 255){octalStr = octalStr.slice(0,-1);octal = parseInt(octalStr,8);}if(octal > 0 && (this.strict || inTemplate)){this.raise(this.pos - 2,"Octal literal in strict mode");}this.pos += octalStr.length - 1;return String.fromCharCode(octal);}return String.fromCharCode(ch);}}; // Used to read character escape sequences ('\x', '\u', '\U').
pp.readHexChar = function(len){var codePos=this.pos;var n=this.readInt(16,len);if(n === null)this.raise(codePos,"Bad character escape sequence");return n;}; // Read an identifier, and return it as a string. Sets `this.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.
pp.readWord1 = function(){this.containsEsc = false;var word="",first=true,chunkStart=this.pos;var astral=this.options.ecmaVersion >= 6;while(this.pos < this.input.length) {var ch=this.fullCharCodeAtPos();if(_identifier.isIdentifierChar(ch,astral)){this.pos += ch <= 0xffff?1:2;}else if(ch === 92){ // "\"
this.containsEsc = true;word += this.input.slice(chunkStart,this.pos);var escStart=this.pos;if(this.input.charCodeAt(++this.pos) != 117) // "u"
this.raise(this.pos,"Expecting Unicode escape sequence \\uXXXX");++this.pos;var esc=this.readCodePoint();if(!(first?_identifier.isIdentifierStart:_identifier.isIdentifierChar)(esc,astral))this.raise(escStart,"Invalid Unicode escape");word += codePointToString(esc);chunkStart = this.pos;}else {break;}first = false;}return word + this.input.slice(chunkStart,this.pos);}; // Read an identifier or keyword token. Will check for reserved
// words when necessary.
pp.readWord = function(){var word=this.readWord1();var type=_tokentype.types.name;if((this.options.ecmaVersion >= 6 || !this.containsEsc) && this.isKeyword(word))type = _tokentype.keywords[word];return this.finishToken(type,word);};},{"./identifier":2,"./locutil":5,"./state":10,"./tokentype":14,"./whitespace":16}],14:[function(_dereq_,module,exports){ // ## Token types
// The assignment of fine-grained, information-carrying type objects
// allows the tokenizer to store the information it has about a
// token in a way that is very cheap for the parser to look up.
// All token type variables start with an underscore, to make them
// easy to recognize.
// The `beforeExpr` property is used to disambiguate between regular
// expressions and divisions. It is set on all token types that can
// be followed by an expression (thus, a slash after them would be a
// regular expression).
//
// `isLoop` marks a keyword as starting a loop, which is important
// to know when parsing a label, in order to allow or disallow
// continue jumps to that label.
"use strict";exports.__esModule = true;function _classCallCheck(instance,Constructor){if(!(instance instanceof Constructor)){throw new TypeError("Cannot call a class as a function");}}var TokenType=function TokenType(label){var conf=arguments.length <= 1 || arguments[1] === undefined?{}:arguments[1];_classCallCheck(this,TokenType);this.label = label;this.keyword = conf.keyword;this.beforeExpr = !!conf.beforeExpr;this.startsExpr = !!conf.startsExpr;this.isLoop = !!conf.isLoop;this.isAssign = !!conf.isAssign;this.prefix = !!conf.prefix;this.postfix = !!conf.postfix;this.binop = conf.binop || null;this.updateContext = null;};exports.TokenType = TokenType;function binop(name,prec){return new TokenType(name,{beforeExpr:true,binop:prec});}var beforeExpr={beforeExpr:true},startsExpr={startsExpr:true};var types={num:new TokenType("num",startsExpr),regexp:new TokenType("regexp",startsExpr),string:new TokenType("string",startsExpr),name:new TokenType("name",startsExpr),eof:new TokenType("eof"), // Punctuation token types.
bracketL:new TokenType("[",{beforeExpr:true,startsExpr:true}),bracketR:new TokenType("]"),braceL:new TokenType("{",{beforeExpr:true,startsExpr:true}),braceR:new TokenType("}"),parenL:new TokenType("(",{beforeExpr:true,startsExpr:true}),parenR:new TokenType(")"),comma:new TokenType(",",beforeExpr),semi:new TokenType(";",beforeExpr),colon:new TokenType(":",beforeExpr),dot:new TokenType("."),question:new TokenType("?",beforeExpr),arrow:new TokenType("=>",beforeExpr),template:new TokenType("template"),ellipsis:new TokenType("...",beforeExpr),backQuote:new TokenType("`",startsExpr),dollarBraceL:new TokenType("${",{beforeExpr:true,startsExpr:true}), // Operators. These carry several kinds of properties to help the
// parser use them properly (the presence of these properties is
// what categorizes them as operators).
//
// `binop`, when present, specifies that this operator is a binary
// operator, and will refer to its precedence.
//
// `prefix` and `postfix` mark the operator as a prefix or postfix
// unary operator.
//
// `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
// binary operators with a very low precedence, that should result
// in AssignmentExpression nodes.
eq:new TokenType("=",{beforeExpr:true,isAssign:true}),assign:new TokenType("_=",{beforeExpr:true,isAssign:true}),incDec:new TokenType("++/--",{prefix:true,postfix:true,startsExpr:true}),prefix:new TokenType("prefix",{beforeExpr:true,prefix:true,startsExpr:true}),logicalOR:binop("||",1),logicalAND:binop("&&",2),bitwiseOR:binop("|",3),bitwiseXOR:binop("^",4),bitwiseAND:binop("&",5),equality:binop("==/!=",6),relational:binop("</>",7),bitShift:binop("<</>>",8),plusMin:new TokenType("+/-",{beforeExpr:true,binop:9,prefix:true,startsExpr:true}),modulo:binop("%",10),star:binop("*",10),slash:binop("/",10)};exports.types = types; // Map keyword names to token types.
var keywords={};exports.keywords = keywords; // Succinct definitions of keyword token types
function kw(name){var options=arguments.length <= 1 || arguments[1] === undefined?{}:arguments[1];options.keyword = name;keywords[name] = types["_" + name] = new TokenType(name,options);}kw("break");kw("case",beforeExpr);kw("catch");kw("continue");kw("debugger");kw("default",beforeExpr);kw("do",{isLoop:true});kw("else",beforeExpr);kw("finally");kw("for",{isLoop:true});kw("function",startsExpr);kw("if");kw("return",beforeExpr);kw("switch");kw("throw",beforeExpr);kw("try");kw("var");kw("let");kw("const");kw("while",{isLoop:true});kw("with");kw("new",{beforeExpr:true,startsExpr:true});kw("this",startsExpr);kw("super",startsExpr);kw("class");kw("extends",beforeExpr);kw("export");kw("import");kw("yield",{beforeExpr:true,startsExpr:true});kw("null",startsExpr);kw("true",startsExpr);kw("false",startsExpr);kw("in",{beforeExpr:true,binop:7});kw("instanceof",{beforeExpr:true,binop:7});kw("typeof",{beforeExpr:true,prefix:true,startsExpr:true});kw("void",{beforeExpr:true,prefix:true,startsExpr:true});kw("delete",{beforeExpr:true,prefix:true,startsExpr:true});},{}],15:[function(_dereq_,module,exports){"use strict";exports.__esModule = true;exports.isArray = isArray;exports.has = has;function isArray(obj){return Object.prototype.toString.call(obj) === "[object Array]";} // Checks if an object has a property.
function has(obj,propName){return Object.prototype.hasOwnProperty.call(obj,propName);}},{}],16:[function(_dereq_,module,exports){ // Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.
"use strict";exports.__esModule = true;exports.isNewLine = isNewLine;var lineBreak=/\r\n?|\n|\u2028|\u2029/;exports.lineBreak = lineBreak;var lineBreakG=new RegExp(lineBreak.source,"g");exports.lineBreakG = lineBreakG;function isNewLine(code){return code === 10 || code === 13 || code === 0x2028 || code == 0x2029;}var nonASCIIwhitespace=/[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000\ufeff]/;exports.nonASCIIwhitespace = nonASCIIwhitespace;},{}]},{},[3])(3);});

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],2:[function(_dereq_,module,exports){
"use strict";

module.exports = typeof acorn != 'undefined' ? acorn : _dereq_("acorn");

},{"acorn":1}],3:[function(_dereq_,module,exports){
"use strict";

var _state = _dereq_("./state");

var _parseutil = _dereq_("./parseutil");

var _ = _dereq_("..");

var lp = _state.LooseParser.prototype;

lp.checkLVal = function (expr, binding) {
  if (!expr) return expr;
  switch (expr.type) {
    case "Identifier":
      return expr;

    case "MemberExpression":
      return binding ? this.dummyIdent() : expr;

    case "ParenthesizedExpression":
      expr.expression = this.checkLVal(expr.expression, binding);
      return expr;

    // FIXME recursively check contents
    case "ObjectPattern":
    case "ArrayPattern":
    case "RestElement":
    case "AssignmentPattern":
      if (this.options.ecmaVersion >= 6) return expr;

    default:
      return this.dummyIdent();
  }
};

lp.parseExpression = function (noIn) {
  var start = this.storeCurrentPos();
  var expr = this.parseMaybeAssign(noIn);
  if (this.tok.type === _.tokTypes.comma) {
    var node = this.startNodeAt(start);
    node.expressions = [expr];
    while (this.eat(_.tokTypes.comma)) node.expressions.push(this.parseMaybeAssign(noIn));
    return this.finishNode(node, "SequenceExpression");
  }
  return expr;
};

lp.parseParenExpression = function () {
  this.pushCx();
  this.expect(_.tokTypes.parenL);
  var val = this.parseExpression();
  this.popCx();
  this.expect(_.tokTypes.parenR);
  return val;
};

lp.parseMaybeAssign = function (noIn) {
  var start = this.storeCurrentPos();
  var left = this.parseMaybeConditional(noIn);
  if (this.tok.type.isAssign) {
    var node = this.startNodeAt(start);
    node.operator = this.tok.value;
    node.left = this.tok.type === _.tokTypes.eq ? this.toAssignable(left) : this.checkLVal(left);
    this.next();
    node.right = this.parseMaybeAssign(noIn);
    return this.finishNode(node, "AssignmentExpression");
  }
  return left;
};

lp.parseMaybeConditional = function (noIn) {
  var start = this.storeCurrentPos();
  var expr = this.parseExprOps(noIn);
  if (this.eat(_.tokTypes.question)) {
    var node = this.startNodeAt(start);
    node.test = expr;
    node.consequent = this.parseMaybeAssign();
    node.alternate = this.expect(_.tokTypes.colon) ? this.parseMaybeAssign(noIn) : this.dummyIdent();
    return this.finishNode(node, "ConditionalExpression");
  }
  return expr;
};

lp.parseExprOps = function (noIn) {
  var start = this.storeCurrentPos();
  var indent = this.curIndent,
      line = this.curLineStart;
  return this.parseExprOp(this.parseMaybeUnary(noIn), start, -1, noIn, indent, line);
};

lp.parseExprOp = function (left, start, minPrec, noIn, indent, line) {
  if (this.curLineStart != line && this.curIndent < indent && this.tokenStartsLine()) return left;
  var prec = this.tok.type.binop;
  if (prec != null && (!noIn || this.tok.type !== _.tokTypes._in)) {
    if (prec > minPrec) {
      var node = this.startNodeAt(start);
      node.left = left;
      node.operator = this.tok.value;
      this.next();
      if (this.curLineStart != line && this.curIndent < indent && this.tokenStartsLine()) {
        node.right = this.dummyIdent();
      } else {
        var rightStart = this.storeCurrentPos();
        node.right = this.parseExprOp(this.parseMaybeUnary(noIn), rightStart, prec, noIn, indent, line);
      }
      this.finishNode(node, /&&|\|\|/.test(node.operator) ? "LogicalExpression" : "BinaryExpression");
      return this.parseExprOp(node, start, minPrec, noIn, indent, line);
    }
  }
  return left;
};

lp.parseMaybeUnary = function (noIn) {
  if (this.tok.type.prefix) {
    var node = this.startNode(),
        update = this.tok.type === _.tokTypes.incDec;
    node.operator = this.tok.value;
    node.prefix = true;
    this.next();
    node.argument = this.parseMaybeUnary(noIn);
    if (update) node.argument = this.checkLVal(node.argument);
    return this.finishNode(node, update ? "UpdateExpression" : "UnaryExpression");
  } else if (this.tok.type === _.tokTypes.ellipsis) {
    var node = this.startNode();
    this.next();
    node.argument = this.parseMaybeUnary(noIn);
    return this.finishNode(node, "SpreadElement");
  }
  var start = this.storeCurrentPos();
  var expr = this.parseExprSubscripts();
  while (this.tok.type.postfix && !this.canInsertSemicolon()) {
    var node = this.startNodeAt(start);
    node.operator = this.tok.value;
    node.prefix = false;
    node.argument = this.checkLVal(expr);
    this.next();
    expr = this.finishNode(node, "UpdateExpression");
  }
  return expr;
};

lp.parseExprSubscripts = function () {
  var start = this.storeCurrentPos();
  return this.parseSubscripts(this.parseExprAtom(), start, false, this.curIndent, this.curLineStart);
};

lp.parseSubscripts = function (base, start, noCalls, startIndent, line) {
  for (;;) {
    if (this.curLineStart != line && this.curIndent <= startIndent && this.tokenStartsLine()) {
      if (this.tok.type == _.tokTypes.dot && this.curIndent == startIndent) --startIndent;else return base;
    }

    if (this.eat(_.tokTypes.dot)) {
      var node = this.startNodeAt(start);
      node.object = base;
      if (this.curLineStart != line && this.curIndent <= startIndent && this.tokenStartsLine()) node.property = this.dummyIdent();else node.property = this.parsePropertyAccessor() || this.dummyIdent();
      node.computed = false;
      base = this.finishNode(node, "MemberExpression");
    } else if (this.tok.type == _.tokTypes.bracketL) {
      this.pushCx();
      this.next();
      var node = this.startNodeAt(start);
      node.object = base;
      node.property = this.parseExpression();
      node.computed = true;
      this.popCx();
      this.expect(_.tokTypes.bracketR);
      base = this.finishNode(node, "MemberExpression");
    } else if (!noCalls && this.tok.type == _.tokTypes.parenL) {
      var node = this.startNodeAt(start);
      node.callee = base;
      node.arguments = this.parseExprList(_.tokTypes.parenR);
      base = this.finishNode(node, "CallExpression");
    } else if (this.tok.type == _.tokTypes.backQuote) {
      var node = this.startNodeAt(start);
      node.tag = base;
      node.quasi = this.parseTemplate();
      base = this.finishNode(node, "TaggedTemplateExpression");
    } else {
      return base;
    }
  }
};

lp.parseExprAtom = function () {
  var node = undefined;
  switch (this.tok.type) {
    case _.tokTypes._this:
    case _.tokTypes._super:
      var type = this.tok.type === _.tokTypes._this ? "ThisExpression" : "Super";
      node = this.startNode();
      this.next();
      return this.finishNode(node, type);

    case _.tokTypes.name:
      var start = this.storeCurrentPos();
      var id = this.parseIdent();
      return this.eat(_.tokTypes.arrow) ? this.parseArrowExpression(this.startNodeAt(start), [id]) : id;

    case _.tokTypes.regexp:
      node = this.startNode();
      var val = this.tok.value;
      node.regex = { pattern: val.pattern, flags: val.flags };
      node.value = val.value;
      node.raw = this.input.slice(this.tok.start, this.tok.end);
      this.next();
      return this.finishNode(node, "Literal");

    case _.tokTypes.num:case _.tokTypes.string:
      node = this.startNode();
      node.value = this.tok.value;
      node.raw = this.input.slice(this.tok.start, this.tok.end);
      this.next();
      return this.finishNode(node, "Literal");

    case _.tokTypes._null:case _.tokTypes._true:case _.tokTypes._false:
      node = this.startNode();
      node.value = this.tok.type === _.tokTypes._null ? null : this.tok.type === _.tokTypes._true;
      node.raw = this.tok.type.keyword;
      this.next();
      return this.finishNode(node, "Literal");

    case _.tokTypes.parenL:
      var parenStart = this.storeCurrentPos();
      this.next();
      var inner = this.parseExpression();
      this.expect(_.tokTypes.parenR);
      if (this.eat(_.tokTypes.arrow)) {
        return this.parseArrowExpression(this.startNodeAt(parenStart), inner.expressions || (_parseutil.isDummy(inner) ? [] : [inner]));
      }
      if (this.options.preserveParens) {
        var par = this.startNodeAt(parenStart);
        par.expression = inner;
        inner = this.finishNode(par, "ParenthesizedExpression");
      }
      return inner;

    case _.tokTypes.bracketL:
      node = this.startNode();
      node.elements = this.parseExprList(_.tokTypes.bracketR, true);
      return this.finishNode(node, "ArrayExpression");

    case _.tokTypes.braceL:
      return this.parseObj();

    case _.tokTypes._class:
      return this.parseClass();

    case _.tokTypes._function:
      node = this.startNode();
      this.next();
      return this.parseFunction(node, false);

    case _.tokTypes._new:
      return this.parseNew();

    case _.tokTypes._yield:
      node = this.startNode();
      this.next();
      if (this.semicolon() || this.canInsertSemicolon() || this.tok.type != _.tokTypes.star && !this.tok.type.startsExpr) {
        node.delegate = false;
        node.argument = null;
      } else {
        node.delegate = this.eat(_.tokTypes.star);
        node.argument = this.parseMaybeAssign();
      }
      return this.finishNode(node, "YieldExpression");

    case _.tokTypes.backQuote:
      return this.parseTemplate();

    default:
      return this.dummyIdent();
  }
};

lp.parseNew = function () {
  var node = this.startNode(),
      startIndent = this.curIndent,
      line = this.curLineStart;
  var meta = this.parseIdent(true);
  if (this.options.ecmaVersion >= 6 && this.eat(_.tokTypes.dot)) {
    node.meta = meta;
    node.property = this.parseIdent(true);
    return this.finishNode(node, "MetaProperty");
  }
  var start = this.storeCurrentPos();
  node.callee = this.parseSubscripts(this.parseExprAtom(), start, true, startIndent, line);
  if (this.tok.type == _.tokTypes.parenL) {
    node.arguments = this.parseExprList(_.tokTypes.parenR);
  } else {
    node.arguments = [];
  }
  return this.finishNode(node, "NewExpression");
};

lp.parseTemplateElement = function () {
  var elem = this.startNode();
  elem.value = {
    raw: this.input.slice(this.tok.start, this.tok.end).replace(/\r\n?/g, '\n'),
    cooked: this.tok.value
  };
  this.next();
  elem.tail = this.tok.type === _.tokTypes.backQuote;
  return this.finishNode(elem, "TemplateElement");
};

lp.parseTemplate = function () {
  var node = this.startNode();
  this.next();
  node.expressions = [];
  var curElt = this.parseTemplateElement();
  node.quasis = [curElt];
  while (!curElt.tail) {
    this.next();
    node.expressions.push(this.parseExpression());
    if (this.expect(_.tokTypes.braceR)) {
      curElt = this.parseTemplateElement();
    } else {
      curElt = this.startNode();
      curElt.value = { cooked: '', raw: '' };
      curElt.tail = true;
    }
    node.quasis.push(curElt);
  }
  this.expect(_.tokTypes.backQuote);
  return this.finishNode(node, "TemplateLiteral");
};

lp.parseObj = function () {
  var node = this.startNode();
  node.properties = [];
  this.pushCx();
  var indent = this.curIndent + 1,
      line = this.curLineStart;
  this.eat(_.tokTypes.braceL);
  if (this.curIndent + 1 < indent) {
    indent = this.curIndent;line = this.curLineStart;
  }
  while (!this.closes(_.tokTypes.braceR, indent, line)) {
    var prop = this.startNode(),
        isGenerator = undefined,
        start = undefined;
    if (this.options.ecmaVersion >= 6) {
      start = this.storeCurrentPos();
      prop.method = false;
      prop.shorthand = false;
      isGenerator = this.eat(_.tokTypes.star);
    }
    this.parsePropertyName(prop);
    if (_parseutil.isDummy(prop.key)) {
      if (_parseutil.isDummy(this.parseMaybeAssign())) this.next();this.eat(_.tokTypes.comma);continue;
    }
    if (this.eat(_.tokTypes.colon)) {
      prop.kind = "init";
      prop.value = this.parseMaybeAssign();
    } else if (this.options.ecmaVersion >= 6 && (this.tok.type === _.tokTypes.parenL || this.tok.type === _.tokTypes.braceL)) {
      prop.kind = "init";
      prop.method = true;
      prop.value = this.parseMethod(isGenerator);
    } else if (this.options.ecmaVersion >= 5 && prop.key.type === "Identifier" && !prop.computed && (prop.key.name === "get" || prop.key.name === "set") && (this.tok.type != _.tokTypes.comma && this.tok.type != _.tokTypes.braceR)) {
      prop.kind = prop.key.name;
      this.parsePropertyName(prop);
      prop.value = this.parseMethod(false);
    } else {
      prop.kind = "init";
      if (this.options.ecmaVersion >= 6) {
        if (this.eat(_.tokTypes.eq)) {
          var assign = this.startNodeAt(start);
          assign.operator = "=";
          assign.left = prop.key;
          assign.right = this.parseMaybeAssign();
          prop.value = this.finishNode(assign, "AssignmentExpression");
        } else {
          prop.value = prop.key;
        }
      } else {
        prop.value = this.dummyIdent();
      }
      prop.shorthand = true;
    }
    node.properties.push(this.finishNode(prop, "Property"));
    this.eat(_.tokTypes.comma);
  }
  this.popCx();
  if (!this.eat(_.tokTypes.braceR)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start;
    if (this.options.locations) this.last.loc.end = this.tok.loc.start;
  }
  return this.finishNode(node, "ObjectExpression");
};

lp.parsePropertyName = function (prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(_.tokTypes.bracketL)) {
      prop.computed = true;
      prop.key = this.parseExpression();
      this.expect(_.tokTypes.bracketR);
      return;
    } else {
      prop.computed = false;
    }
  }
  var key = this.tok.type === _.tokTypes.num || this.tok.type === _.tokTypes.string ? this.parseExprAtom() : this.parseIdent();
  prop.key = key || this.dummyIdent();
};

lp.parsePropertyAccessor = function () {
  if (this.tok.type === _.tokTypes.name || this.tok.type.keyword) return this.parseIdent();
};

lp.parseIdent = function () {
  var name = this.tok.type === _.tokTypes.name ? this.tok.value : this.tok.type.keyword;
  if (!name) return this.dummyIdent();
  var node = this.startNode();
  this.next();
  node.name = name;
  return this.finishNode(node, "Identifier");
};

lp.initFunction = function (node) {
  node.id = null;
  node.params = [];
  if (this.options.ecmaVersion >= 6) {
    node.generator = false;
    node.expression = false;
  }
};

// Convert existing expression atom to assignable pattern
// if possible.

lp.toAssignable = function (node, binding) {
  if (this.options.ecmaVersion >= 6 && node) {
    switch (node.type) {
      case "ObjectExpression":
        node.type = "ObjectPattern";
        var props = node.properties;
        for (var i = 0; i < props.length; i++) {
          this.toAssignable(props[i].value, binding);
        }break;

      case "ArrayExpression":
        node.type = "ArrayPattern";
        this.toAssignableList(node.elements, binding);
        break;

      case "SpreadElement":
        node.type = "RestElement";
        node.argument = this.toAssignable(node.argument, binding);
        break;

      case "AssignmentExpression":
        node.type = "AssignmentPattern";
        delete node.operator;
        break;
    }
  }
  return this.checkLVal(node, binding);
};

lp.toAssignableList = function (exprList, binding) {
  for (var i = 0; i < exprList.length; i++) {
    exprList[i] = this.toAssignable(exprList[i], binding);
  }return exprList;
};

lp.parseFunctionParams = function (params) {
  params = this.parseExprList(_.tokTypes.parenR);
  return this.toAssignableList(params, true);
};

lp.parseMethod = function (isGenerator) {
  var node = this.startNode();
  this.initFunction(node);
  node.params = this.parseFunctionParams();
  node.generator = isGenerator || false;
  node.expression = this.options.ecmaVersion >= 6 && this.tok.type !== _.tokTypes.braceL;
  node.body = node.expression ? this.parseMaybeAssign() : this.parseBlock();
  return this.finishNode(node, "FunctionExpression");
};

lp.parseArrowExpression = function (node, params) {
  this.initFunction(node);
  node.params = this.toAssignableList(params, true);
  node.expression = this.tok.type !== _.tokTypes.braceL;
  node.body = node.expression ? this.parseMaybeAssign() : this.parseBlock();
  return this.finishNode(node, "ArrowFunctionExpression");
};

lp.parseExprList = function (close, allowEmpty) {
  this.pushCx();
  var indent = this.curIndent,
      line = this.curLineStart,
      elts = [];
  this.next(); // Opening bracket
  while (!this.closes(close, indent + 1, line)) {
    if (this.eat(_.tokTypes.comma)) {
      elts.push(allowEmpty ? null : this.dummyIdent());
      continue;
    }
    var elt = this.parseMaybeAssign();
    if (_parseutil.isDummy(elt)) {
      if (this.closes(close, indent, line)) break;
      this.next();
    } else {
      elts.push(elt);
    }
    this.eat(_.tokTypes.comma);
  }
  this.popCx();
  if (!this.eat(close)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start;
    if (this.options.locations) this.last.loc.end = this.tok.loc.start;
  }
  return elts;
};

},{"..":2,"./parseutil":5,"./state":6}],4:[function(_dereq_,module,exports){
// Acorn: Loose parser
//
// This module provides an alternative parser (`parse_dammit`) that
// exposes that same interface as `parse`, but will try to parse
// anything as JavaScript, repairing syntax error the best it can.
// There are circumstances in which it will raise an error and give
// up, but they are very rare. The resulting AST will be a mostly
// valid JavaScript AST (as per the [Mozilla parser API][api], except
// that:
//
// - Return outside functions is allowed
//
// - Label consistency (no conflicts, break only to existing labels)
//   is not enforced.
//
// - Bogus Identifier nodes with a name of `"✖"` are inserted whenever
//   the parser got too confused to return anything meaningful.
//
// [api]: https://developer.mozilla.org/en-US/docs/SpiderMonkey/Parser_API
//
// The expected use for this is to *first* try `acorn.parse`, and only
// if that fails switch to `parse_dammit`. The loose parser might
// parse badly indented code incorrectly, so **don't** use it as
// your default parser.
//
// Quite a lot of acorn.js is duplicated here. The alternative was to
// add a *lot* of extra cruft to that file, making it less readable
// and slower. Copying and editing the code allowed me to make
// invasive changes and simplifications without creating a complicated
// tangle.

"use strict";

exports.__esModule = true;
exports.parse_dammit = parse_dammit;

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj["default"] = obj; return newObj; } }

var _ = _dereq_("..");

var acorn = _interopRequireWildcard(_);

var _state = _dereq_("./state");

_dereq_("./tokenize");

_dereq_("./statement");

_dereq_("./expression");

exports.LooseParser = _state.LooseParser;

acorn.defaultOptions.tabSize = 4;

function parse_dammit(input, options) {
  var p = new _state.LooseParser(input, options);
  p.next();
  return p.parseTopLevel();
}

acorn.parse_dammit = parse_dammit;
acorn.LooseParser = _state.LooseParser;

},{"..":2,"./expression":3,"./state":6,"./statement":7,"./tokenize":8}],5:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;
exports.isDummy = isDummy;

function isDummy(node) {
  return node.name == "✖";
}

},{}],6:[function(_dereq_,module,exports){
"use strict";

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var _ = _dereq_("..");

var LooseParser = (function () {
  function LooseParser(input, options) {
    _classCallCheck(this, LooseParser);

    this.toks = _.tokenizer(input, options);
    this.options = this.toks.options;
    this.input = this.toks.input;
    this.tok = this.last = { type: _.tokTypes.eof, start: 0, end: 0 };
    if (this.options.locations) {
      var here = this.toks.curPosition();
      this.tok.loc = new _.SourceLocation(this.toks, here, here);
    }
    this.ahead = []; // Tokens ahead
    this.context = []; // Indentation contexted
    this.curIndent = 0;
    this.curLineStart = 0;
    this.nextLineStart = this.lineEnd(this.curLineStart) + 1;
  }

  LooseParser.prototype.startNode = function startNode() {
    return new _.Node(this.toks, this.tok.start, this.options.locations ? this.tok.loc.start : null);
  };

  LooseParser.prototype.storeCurrentPos = function storeCurrentPos() {
    return this.options.locations ? [this.tok.start, this.tok.loc.start] : this.tok.start;
  };

  LooseParser.prototype.startNodeAt = function startNodeAt(pos) {
    if (this.options.locations) {
      return new _.Node(this.toks, pos[0], pos[1]);
    } else {
      return new _.Node(this.toks, pos);
    }
  };

  LooseParser.prototype.finishNode = function finishNode(node, type) {
    node.type = type;
    node.end = this.last.end;
    if (this.options.locations) node.loc.end = this.last.loc.end;
    if (this.options.ranges) node.range[1] = this.last.end;
    return node;
  };

  LooseParser.prototype.dummyIdent = function dummyIdent() {
    var dummy = this.startNode();
    dummy.name = "✖";
    return this.finishNode(dummy, "Identifier");
  };

  LooseParser.prototype.eat = function eat(type) {
    if (this.tok.type === type) {
      this.next();
      return true;
    } else {
      return false;
    }
  };

  LooseParser.prototype.isContextual = function isContextual(name) {
    return this.tok.type === _.tokTypes.name && this.tok.value === name;
  };

  LooseParser.prototype.eatContextual = function eatContextual(name) {
    return this.tok.value === name && this.eat(_.tokTypes.name);
  };

  LooseParser.prototype.canInsertSemicolon = function canInsertSemicolon() {
    return this.tok.type === _.tokTypes.eof || this.tok.type === _.tokTypes.braceR || _.lineBreak.test(this.input.slice(this.last.end, this.tok.start));
  };

  LooseParser.prototype.semicolon = function semicolon() {
    return this.eat(_.tokTypes.semi);
  };

  LooseParser.prototype.expect = function expect(type) {
    if (this.eat(type)) return true;
    for (var i = 1; i <= 2; i++) {
      if (this.lookAhead(i).type == type) {
        for (var j = 0; j < i; j++) {
          this.next();
        }return true;
      }
    }
  };

  LooseParser.prototype.pushCx = function pushCx() {
    this.context.push(this.curIndent);
  };

  LooseParser.prototype.popCx = function popCx() {
    this.curIndent = this.context.pop();
  };

  LooseParser.prototype.lineEnd = function lineEnd(pos) {
    while (pos < this.input.length && !_.isNewLine(this.input.charCodeAt(pos))) ++pos;
    return pos;
  };

  LooseParser.prototype.indentationAfter = function indentationAfter(pos) {
    for (var count = 0;; ++pos) {
      var ch = this.input.charCodeAt(pos);
      if (ch === 32) ++count;else if (ch === 9) count += this.options.tabSize;else return count;
    }
  };

  LooseParser.prototype.closes = function closes(closeTok, indent, line, blockHeuristic) {
    if (this.tok.type === closeTok || this.tok.type === _.tokTypes.eof) return true;
    return line != this.curLineStart && this.curIndent < indent && this.tokenStartsLine() && (!blockHeuristic || this.nextLineStart >= this.input.length || this.indentationAfter(this.nextLineStart) < indent);
  };

  LooseParser.prototype.tokenStartsLine = function tokenStartsLine() {
    for (var p = this.tok.start - 1; p >= this.curLineStart; --p) {
      var ch = this.input.charCodeAt(p);
      if (ch !== 9 && ch !== 32) return false;
    }
    return true;
  };

  return LooseParser;
})();

exports.LooseParser = LooseParser;

},{"..":2}],7:[function(_dereq_,module,exports){
"use strict";

var _state = _dereq_("./state");

var _parseutil = _dereq_("./parseutil");

var _ = _dereq_("..");

var lp = _state.LooseParser.prototype;

lp.parseTopLevel = function () {
  var node = this.startNodeAt(this.options.locations ? [0, _.getLineInfo(this.input, 0)] : 0);
  node.body = [];
  while (this.tok.type !== _.tokTypes.eof) node.body.push(this.parseStatement());
  this.last = this.tok;
  if (this.options.ecmaVersion >= 6) {
    node.sourceType = this.options.sourceType;
  }
  return this.finishNode(node, "Program");
};

lp.parseStatement = function () {
  var starttype = this.tok.type,
      node = this.startNode();

  switch (starttype) {
    case _.tokTypes._break:case _.tokTypes._continue:
      this.next();
      var isBreak = starttype === _.tokTypes._break;
      if (this.semicolon() || this.canInsertSemicolon()) {
        node.label = null;
      } else {
        node.label = this.tok.type === _.tokTypes.name ? this.parseIdent() : null;
        this.semicolon();
      }
      return this.finishNode(node, isBreak ? "BreakStatement" : "ContinueStatement");

    case _.tokTypes._debugger:
      this.next();
      this.semicolon();
      return this.finishNode(node, "DebuggerStatement");

    case _.tokTypes._do:
      this.next();
      node.body = this.parseStatement();
      node.test = this.eat(_.tokTypes._while) ? this.parseParenExpression() : this.dummyIdent();
      this.semicolon();
      return this.finishNode(node, "DoWhileStatement");

    case _.tokTypes._for:
      this.next();
      this.pushCx();
      this.expect(_.tokTypes.parenL);
      if (this.tok.type === _.tokTypes.semi) return this.parseFor(node, null);
      if (this.tok.type === _.tokTypes._var || this.tok.type === _.tokTypes._let || this.tok.type === _.tokTypes._const) {
        var _init = this.parseVar(true);
        if (_init.declarations.length === 1 && (this.tok.type === _.tokTypes._in || this.isContextual("of"))) {
          return this.parseForIn(node, _init);
        }
        return this.parseFor(node, _init);
      }
      var init = this.parseExpression(true);
      if (this.tok.type === _.tokTypes._in || this.isContextual("of")) return this.parseForIn(node, this.toAssignable(init));
      return this.parseFor(node, init);

    case _.tokTypes._function:
      this.next();
      return this.parseFunction(node, true);

    case _.tokTypes._if:
      this.next();
      node.test = this.parseParenExpression();
      node.consequent = this.parseStatement();
      node.alternate = this.eat(_.tokTypes._else) ? this.parseStatement() : null;
      return this.finishNode(node, "IfStatement");

    case _.tokTypes._return:
      this.next();
      if (this.eat(_.tokTypes.semi) || this.canInsertSemicolon()) node.argument = null;else {
        node.argument = this.parseExpression();this.semicolon();
      }
      return this.finishNode(node, "ReturnStatement");

    case _.tokTypes._switch:
      var blockIndent = this.curIndent,
          line = this.curLineStart;
      this.next();
      node.discriminant = this.parseParenExpression();
      node.cases = [];
      this.pushCx();
      this.expect(_.tokTypes.braceL);

      var cur = undefined;
      while (!this.closes(_.tokTypes.braceR, blockIndent, line, true)) {
        if (this.tok.type === _.tokTypes._case || this.tok.type === _.tokTypes._default) {
          var isCase = this.tok.type === _.tokTypes._case;
          if (cur) this.finishNode(cur, "SwitchCase");
          node.cases.push(cur = this.startNode());
          cur.consequent = [];
          this.next();
          if (isCase) cur.test = this.parseExpression();else cur.test = null;
          this.expect(_.tokTypes.colon);
        } else {
          if (!cur) {
            node.cases.push(cur = this.startNode());
            cur.consequent = [];
            cur.test = null;
          }
          cur.consequent.push(this.parseStatement());
        }
      }
      if (cur) this.finishNode(cur, "SwitchCase");
      this.popCx();
      this.eat(_.tokTypes.braceR);
      return this.finishNode(node, "SwitchStatement");

    case _.tokTypes._throw:
      this.next();
      node.argument = this.parseExpression();
      this.semicolon();
      return this.finishNode(node, "ThrowStatement");

    case _.tokTypes._try:
      this.next();
      node.block = this.parseBlock();
      node.handler = null;
      if (this.tok.type === _.tokTypes._catch) {
        var clause = this.startNode();
        this.next();
        this.expect(_.tokTypes.parenL);
        clause.param = this.toAssignable(this.parseExprAtom(), true);
        this.expect(_.tokTypes.parenR);
        clause.guard = null;
        clause.body = this.parseBlock();
        node.handler = this.finishNode(clause, "CatchClause");
      }
      node.finalizer = this.eat(_.tokTypes._finally) ? this.parseBlock() : null;
      if (!node.handler && !node.finalizer) return node.block;
      return this.finishNode(node, "TryStatement");

    case _.tokTypes._var:
    case _.tokTypes._let:
    case _.tokTypes._const:
      return this.parseVar();

    case _.tokTypes._while:
      this.next();
      node.test = this.parseParenExpression();
      node.body = this.parseStatement();
      return this.finishNode(node, "WhileStatement");

    case _.tokTypes._with:
      this.next();
      node.object = this.parseParenExpression();
      node.body = this.parseStatement();
      return this.finishNode(node, "WithStatement");

    case _.tokTypes.braceL:
      return this.parseBlock();

    case _.tokTypes.semi:
      this.next();
      return this.finishNode(node, "EmptyStatement");

    case _.tokTypes._class:
      return this.parseClass(true);

    case _.tokTypes._import:
      return this.parseImport();

    case _.tokTypes._export:
      return this.parseExport();

    default:
      var expr = this.parseExpression();
      if (_parseutil.isDummy(expr)) {
        this.next();
        if (this.tok.type === _.tokTypes.eof) return this.finishNode(node, "EmptyStatement");
        return this.parseStatement();
      } else if (starttype === _.tokTypes.name && expr.type === "Identifier" && this.eat(_.tokTypes.colon)) {
        node.body = this.parseStatement();
        node.label = expr;
        return this.finishNode(node, "LabeledStatement");
      } else {
        node.expression = expr;
        this.semicolon();
        return this.finishNode(node, "ExpressionStatement");
      }
  }
};

lp.parseBlock = function () {
  var node = this.startNode();
  this.pushCx();
  this.expect(_.tokTypes.braceL);
  var blockIndent = this.curIndent,
      line = this.curLineStart;
  node.body = [];
  while (!this.closes(_.tokTypes.braceR, blockIndent, line, true)) node.body.push(this.parseStatement());
  this.popCx();
  this.eat(_.tokTypes.braceR);
  return this.finishNode(node, "BlockStatement");
};

lp.parseFor = function (node, init) {
  node.init = init;
  node.test = node.update = null;
  if (this.eat(_.tokTypes.semi) && this.tok.type !== _.tokTypes.semi) node.test = this.parseExpression();
  if (this.eat(_.tokTypes.semi) && this.tok.type !== _.tokTypes.parenR) node.update = this.parseExpression();
  this.popCx();
  this.expect(_.tokTypes.parenR);
  node.body = this.parseStatement();
  return this.finishNode(node, "ForStatement");
};

lp.parseForIn = function (node, init) {
  var type = this.tok.type === _.tokTypes._in ? "ForInStatement" : "ForOfStatement";
  this.next();
  node.left = init;
  node.right = this.parseExpression();
  this.popCx();
  this.expect(_.tokTypes.parenR);
  node.body = this.parseStatement();
  return this.finishNode(node, type);
};

lp.parseVar = function (noIn) {
  var node = this.startNode();
  node.kind = this.tok.type.keyword;
  this.next();
  node.declarations = [];
  do {
    var decl = this.startNode();
    decl.id = this.options.ecmaVersion >= 6 ? this.toAssignable(this.parseExprAtom(), true) : this.parseIdent();
    decl.init = this.eat(_.tokTypes.eq) ? this.parseMaybeAssign(noIn) : null;
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
  } while (this.eat(_.tokTypes.comma));
  if (!node.declarations.length) {
    var decl = this.startNode();
    decl.id = this.dummyIdent();
    node.declarations.push(this.finishNode(decl, "VariableDeclarator"));
  }
  if (!noIn) this.semicolon();
  return this.finishNode(node, "VariableDeclaration");
};

lp.parseClass = function (isStatement) {
  var node = this.startNode();
  this.next();
  if (this.tok.type === _.tokTypes.name) node.id = this.parseIdent();else if (isStatement) node.id = this.dummyIdent();else node.id = null;
  node.superClass = this.eat(_.tokTypes._extends) ? this.parseExpression() : null;
  node.body = this.startNode();
  node.body.body = [];
  this.pushCx();
  var indent = this.curIndent + 1,
      line = this.curLineStart;
  this.eat(_.tokTypes.braceL);
  if (this.curIndent + 1 < indent) {
    indent = this.curIndent;line = this.curLineStart;
  }
  while (!this.closes(_.tokTypes.braceR, indent, line)) {
    if (this.semicolon()) continue;
    var method = this.startNode(),
        isGenerator = undefined;
    if (this.options.ecmaVersion >= 6) {
      method["static"] = false;
      isGenerator = this.eat(_.tokTypes.star);
    }
    this.parsePropertyName(method);
    if (_parseutil.isDummy(method.key)) {
      if (_parseutil.isDummy(this.parseMaybeAssign())) this.next();this.eat(_.tokTypes.comma);continue;
    }
    if (method.key.type === "Identifier" && !method.computed && method.key.name === "static" && (this.tok.type != _.tokTypes.parenL && this.tok.type != _.tokTypes.braceL)) {
      method["static"] = true;
      isGenerator = this.eat(_.tokTypes.star);
      this.parsePropertyName(method);
    } else {
      method["static"] = false;
    }
    if (this.options.ecmaVersion >= 5 && method.key.type === "Identifier" && !method.computed && (method.key.name === "get" || method.key.name === "set") && this.tok.type !== _.tokTypes.parenL && this.tok.type !== _.tokTypes.braceL) {
      method.kind = method.key.name;
      this.parsePropertyName(method);
      method.value = this.parseMethod(false);
    } else {
      if (!method.computed && !method["static"] && !isGenerator && (method.key.type === "Identifier" && method.key.name === "constructor" || method.key.type === "Literal" && method.key.value === "constructor")) {
        method.kind = "constructor";
      } else {
        method.kind = "method";
      }
      method.value = this.parseMethod(isGenerator);
    }
    node.body.body.push(this.finishNode(method, "MethodDefinition"));
  }
  this.popCx();
  if (!this.eat(_.tokTypes.braceR)) {
    // If there is no closing brace, make the node span to the start
    // of the next token (this is useful for Tern)
    this.last.end = this.tok.start;
    if (this.options.locations) this.last.loc.end = this.tok.loc.start;
  }
  this.semicolon();
  this.finishNode(node.body, "ClassBody");
  return this.finishNode(node, isStatement ? "ClassDeclaration" : "ClassExpression");
};

lp.parseFunction = function (node, isStatement) {
  this.initFunction(node);
  if (this.options.ecmaVersion >= 6) {
    node.generator = this.eat(_.tokTypes.star);
  }
  if (this.tok.type === _.tokTypes.name) node.id = this.parseIdent();else if (isStatement) node.id = this.dummyIdent();
  node.params = this.parseFunctionParams();
  node.body = this.parseBlock();
  return this.finishNode(node, isStatement ? "FunctionDeclaration" : "FunctionExpression");
};

lp.parseExport = function () {
  var node = this.startNode();
  this.next();
  if (this.eat(_.tokTypes.star)) {
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null;
    return this.finishNode(node, "ExportAllDeclaration");
  }
  if (this.eat(_.tokTypes._default)) {
    var expr = this.parseMaybeAssign();
    if (expr.id) {
      switch (expr.type) {
        case "FunctionExpression":
          expr.type = "FunctionDeclaration";break;
        case "ClassExpression":
          expr.type = "ClassDeclaration";break;
      }
    }
    node.declaration = expr;
    this.semicolon();
    return this.finishNode(node, "ExportDefaultDeclaration");
  }
  if (this.tok.type.keyword) {
    node.declaration = this.parseStatement();
    node.specifiers = [];
    node.source = null;
  } else {
    node.declaration = null;
    node.specifiers = this.parseExportSpecifierList();
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null;
    this.semicolon();
  }
  return this.finishNode(node, "ExportNamedDeclaration");
};

lp.parseImport = function () {
  var node = this.startNode();
  this.next();
  if (this.tok.type === _.tokTypes.string) {
    node.specifiers = [];
    node.source = this.parseExprAtom();
    node.kind = '';
  } else {
    var elt = undefined;
    if (this.tok.type === _.tokTypes.name && this.tok.value !== "from") {
      elt = this.startNode();
      elt.local = this.parseIdent();
      this.finishNode(elt, "ImportDefaultSpecifier");
      this.eat(_.tokTypes.comma);
    }
    node.specifiers = this.parseImportSpecifierList();
    node.source = this.eatContextual("from") ? this.parseExprAtom() : null;
    if (elt) node.specifiers.unshift(elt);
  }
  this.semicolon();
  return this.finishNode(node, "ImportDeclaration");
};

lp.parseImportSpecifierList = function () {
  var elts = [];
  if (this.tok.type === _.tokTypes.star) {
    var elt = this.startNode();
    this.next();
    if (this.eatContextual("as")) elt.local = this.parseIdent();
    elts.push(this.finishNode(elt, "ImportNamespaceSpecifier"));
  } else {
    var indent = this.curIndent,
        line = this.curLineStart,
        continuedLine = this.nextLineStart;
    this.pushCx();
    this.eat(_.tokTypes.braceL);
    if (this.curLineStart > continuedLine) continuedLine = this.curLineStart;
    while (!this.closes(_.tokTypes.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
      var elt = this.startNode();
      if (this.eat(_.tokTypes.star)) {
        if (this.eatContextual("as")) elt.local = this.parseIdent();
        this.finishNode(elt, "ImportNamespaceSpecifier");
      } else {
        if (this.isContextual("from")) break;
        elt.imported = this.parseIdent();
        if (_parseutil.isDummy(elt.imported)) break;
        elt.local = this.eatContextual("as") ? this.parseIdent() : elt.imported;
        this.finishNode(elt, "ImportSpecifier");
      }
      elts.push(elt);
      this.eat(_.tokTypes.comma);
    }
    this.eat(_.tokTypes.braceR);
    this.popCx();
  }
  return elts;
};

lp.parseExportSpecifierList = function () {
  var elts = [];
  var indent = this.curIndent,
      line = this.curLineStart,
      continuedLine = this.nextLineStart;
  this.pushCx();
  this.eat(_.tokTypes.braceL);
  if (this.curLineStart > continuedLine) continuedLine = this.curLineStart;
  while (!this.closes(_.tokTypes.braceR, indent + (this.curLineStart <= continuedLine ? 1 : 0), line)) {
    if (this.isContextual("from")) break;
    var elt = this.startNode();
    elt.local = this.parseIdent();
    if (_parseutil.isDummy(elt.local)) break;
    elt.exported = this.eatContextual("as") ? this.parseIdent() : elt.local;
    this.finishNode(elt, "ExportSpecifier");
    elts.push(elt);
    this.eat(_.tokTypes.comma);
  }
  this.eat(_.tokTypes.braceR);
  this.popCx();
  return elts;
};

},{"..":2,"./parseutil":5,"./state":6}],8:[function(_dereq_,module,exports){
"use strict";

var _ = _dereq_("..");

var _state = _dereq_("./state");

var lp = _state.LooseParser.prototype;

function isSpace(ch) {
  return ch < 14 && ch > 8 || ch === 32 || ch === 160 || _.isNewLine(ch);
}

lp.next = function () {
  this.last = this.tok;
  if (this.ahead.length) this.tok = this.ahead.shift();else this.tok = this.readToken();

  if (this.tok.start >= this.nextLineStart) {
    while (this.tok.start >= this.nextLineStart) {
      this.curLineStart = this.nextLineStart;
      this.nextLineStart = this.lineEnd(this.curLineStart) + 1;
    }
    this.curIndent = this.indentationAfter(this.curLineStart);
  }
};

lp.readToken = function () {
  for (;;) {
    try {
      this.toks.next();
      if (this.toks.type === _.tokTypes.dot && this.input.substr(this.toks.end, 1) === "." && this.options.ecmaVersion >= 6) {
        this.toks.end++;
        this.toks.type = _.tokTypes.ellipsis;
      }
      return new _.Token(this.toks);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;

      // Try to skip some text, based on the error message, and then continue
      var msg = e.message,
          pos = e.raisedAt,
          replace = true;
      if (/unterminated/i.test(msg)) {
        pos = this.lineEnd(e.pos + 1);
        if (/string/.test(msg)) {
          replace = { start: e.pos, end: pos, type: _.tokTypes.string, value: this.input.slice(e.pos + 1, pos) };
        } else if (/regular expr/i.test(msg)) {
          var re = this.input.slice(e.pos, pos);
          try {
            re = new RegExp(re);
          } catch (e) {}
          replace = { start: e.pos, end: pos, type: _.tokTypes.regexp, value: re };
        } else if (/template/.test(msg)) {
          replace = { start: e.pos, end: pos,
            type: _.tokTypes.template,
            value: this.input.slice(e.pos, pos) };
        } else {
          replace = false;
        }
      } else if (/invalid (unicode|regexp|number)|expecting unicode|octal literal|is reserved|directly after number|expected number in radix/i.test(msg)) {
        while (pos < this.input.length && !isSpace(this.input.charCodeAt(pos))) ++pos;
      } else if (/character escape|expected hexadecimal/i.test(msg)) {
        while (pos < this.input.length) {
          var ch = this.input.charCodeAt(pos++);
          if (ch === 34 || ch === 39 || _.isNewLine(ch)) break;
        }
      } else if (/unexpected character/i.test(msg)) {
        pos++;
        replace = false;
      } else if (/regular expression/i.test(msg)) {
        replace = true;
      } else {
        throw e;
      }
      this.resetTo(pos);
      if (replace === true) replace = { start: pos, end: pos, type: _.tokTypes.name, value: "✖" };
      if (replace) {
        if (this.options.locations) replace.loc = new _.SourceLocation(this.toks, _.getLineInfo(this.input, replace.start), _.getLineInfo(this.input, replace.end));
        return replace;
      }
    }
  }
};

lp.resetTo = function (pos) {
  this.toks.pos = pos;
  var ch = this.input.charAt(pos - 1);
  this.toks.exprAllowed = !ch || /[\[\{\(,;:?\/*=+\-~!|&%^<>]/.test(ch) || /[enwfd]/.test(ch) && /\b(keywords|case|else|return|throw|new|in|(instance|type)of|delete|void)$/.test(this.input.slice(pos - 10, pos));

  if (this.options.locations) {
    this.toks.curLine = 1;
    this.toks.lineStart = _.lineBreakG.lastIndex = 0;
    var match = undefined;
    while ((match = _.lineBreakG.exec(this.input)) && match.index < pos) {
      ++this.toks.curLine;
      this.toks.lineStart = match.index + match[0].length;
    }
  }
};

lp.lookAhead = function (n) {
  while (n > this.ahead.length) this.ahead.push(this.readToken());
  return this.ahead[n - 1];
};

},{"..":2,"./state":6}]},{},[4])(4)
});
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],16:[function(require,module,exports){
(function (global){
(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}(g.acorn || (g.acorn = {})).walk = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
// AST walker module for Mozilla Parser API compatible trees

// A simple walk is one where you simply specify callbacks to be
// called on specific nodes. The last two arguments are optional. A
// simple use would be
//
//     walk.simple(myTree, {
//         Expression: function(node) { ... }
//     });
//
// to do something with all expressions. All Parser API node types
// can be used to identify node types, as well as Expression,
// Statement, and ScopeBody, which denote categories of nodes.
//
// The base argument can be used to pass a custom (recursive)
// walker, and state can be used to give this walked an initial
// state.

"use strict";

exports.__esModule = true;
exports.simple = simple;
exports.ancestor = ancestor;
exports.recursive = recursive;
exports.findNodeAt = findNodeAt;
exports.findNodeAround = findNodeAround;
exports.findNodeAfter = findNodeAfter;
exports.findNodeBefore = findNodeBefore;
exports.make = make;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function simple(node, visitors, base, state, override) {
  if (!base) base = exports.base;(function c(node, st, override) {
    var type = override || node.type,
        found = visitors[type];
    base[type](node, st, c);
    if (found) found(node, st);
  })(node, state, override);
}

// An ancestor walk builds up an array of ancestor nodes (including
// the current node) and passes them to the callback as the state parameter.

function ancestor(node, visitors, base, state) {
  if (!base) base = exports.base;
  if (!state) state = [];(function c(node, st, override) {
    var type = override || node.type,
        found = visitors[type];
    if (node != st[st.length - 1]) {
      st = st.slice();
      st.push(node);
    }
    base[type](node, st, c);
    if (found) found(node, st);
  })(node, state);
}

// A recursive walk is one where your functions override the default
// walkers. They can modify and replace the state parameter that's
// threaded through the walk, and can opt how and whether to walk
// their child nodes (by calling their third argument on these
// nodes).

function recursive(node, state, funcs, base, override) {
  var visitor = funcs ? exports.make(funcs, base) : base;(function c(node, st, override) {
    visitor[override || node.type](node, st, c);
  })(node, state, override);
}

function makeTest(test) {
  if (typeof test == "string") return function (type) {
    return type == test;
  };else if (!test) return function () {
    return true;
  };else return test;
}

var Found = function Found(node, state) {
  _classCallCheck(this, Found);

  this.node = node;this.state = state;
}

// Find a node with a given start, end, and type (all are optional,
// null can be used as wildcard). Returns a {node, state} object, or
// undefined when it doesn't find a matching node.
;

function findNodeAt(node, start, end, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  try {
    ;(function c(node, st, override) {
      var type = override || node.type;
      if ((start == null || node.start <= start) && (end == null || node.end >= end)) base[type](node, st, c);
      if (test(type, node) && (start == null || node.start == start) && (end == null || node.end == end)) throw new Found(node, st);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) return e;
    throw e;
  }
}

// Find the innermost node of a given type that contains the given
// position. Interface similar to findNodeAt.

function findNodeAround(node, pos, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  try {
    ;(function c(node, st, override) {
      var type = override || node.type;
      if (node.start > pos || node.end < pos) return;
      base[type](node, st, c);
      if (test(type, node)) throw new Found(node, st);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) return e;
    throw e;
  }
}

// Find the outermost matching node after a given position.

function findNodeAfter(node, pos, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  try {
    ;(function c(node, st, override) {
      if (node.end < pos) return;
      var type = override || node.type;
      if (node.start >= pos && test(type, node)) throw new Found(node, st);
      base[type](node, st, c);
    })(node, state);
  } catch (e) {
    if (e instanceof Found) return e;
    throw e;
  }
}

// Find the outermost matching node before a given position.

function findNodeBefore(node, pos, test, base, state) {
  test = makeTest(test);
  if (!base) base = exports.base;
  var max = undefined;(function c(node, st, override) {
    if (node.start > pos) return;
    var type = override || node.type;
    if (node.end <= pos && (!max || max.node.end < node.end) && test(type, node)) max = new Found(node, st);
    base[type](node, st, c);
  })(node, state);
  return max;
}

// Used to create a custom walker. Will fill in all missing node
// type properties with the defaults.

function make(funcs, base) {
  if (!base) base = exports.base;
  var visitor = {};
  for (var type in base) visitor[type] = base[type];
  for (var type in funcs) visitor[type] = funcs[type];
  return visitor;
}

function skipThrough(node, st, c) {
  c(node, st);
}
function ignore(_node, _st, _c) {}

// Node walkers.

var base = {};

exports.base = base;
base.Program = base.BlockStatement = function (node, st, c) {
  for (var i = 0; i < node.body.length; ++i) {
    c(node.body[i], st, "Statement");
  }
};
base.Statement = skipThrough;
base.EmptyStatement = ignore;
base.ExpressionStatement = base.ParenthesizedExpression = function (node, st, c) {
  return c(node.expression, st, "Expression");
};
base.IfStatement = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Statement");
  if (node.alternate) c(node.alternate, st, "Statement");
};
base.LabeledStatement = function (node, st, c) {
  return c(node.body, st, "Statement");
};
base.BreakStatement = base.ContinueStatement = ignore;
base.WithStatement = function (node, st, c) {
  c(node.object, st, "Expression");
  c(node.body, st, "Statement");
};
base.SwitchStatement = function (node, st, c) {
  c(node.discriminant, st, "Expression");
  for (var i = 0; i < node.cases.length; ++i) {
    var cs = node.cases[i];
    if (cs.test) c(cs.test, st, "Expression");
    for (var j = 0; j < cs.consequent.length; ++j) {
      c(cs.consequent[j], st, "Statement");
    }
  }
};
base.ReturnStatement = base.YieldExpression = function (node, st, c) {
  if (node.argument) c(node.argument, st, "Expression");
};
base.ThrowStatement = base.SpreadElement = function (node, st, c) {
  return c(node.argument, st, "Expression");
};
base.TryStatement = function (node, st, c) {
  c(node.block, st, "Statement");
  if (node.handler) {
    c(node.handler.param, st, "Pattern");
    c(node.handler.body, st, "ScopeBody");
  }
  if (node.finalizer) c(node.finalizer, st, "Statement");
};
base.WhileStatement = base.DoWhileStatement = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForStatement = function (node, st, c) {
  if (node.init) c(node.init, st, "ForInit");
  if (node.test) c(node.test, st, "Expression");
  if (node.update) c(node.update, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForInStatement = base.ForOfStatement = function (node, st, c) {
  c(node.left, st, "ForInit");
  c(node.right, st, "Expression");
  c(node.body, st, "Statement");
};
base.ForInit = function (node, st, c) {
  if (node.type == "VariableDeclaration") c(node, st);else c(node, st, "Expression");
};
base.DebuggerStatement = ignore;

base.FunctionDeclaration = function (node, st, c) {
  return c(node, st, "Function");
};
base.VariableDeclaration = function (node, st, c) {
  for (var i = 0; i < node.declarations.length; ++i) {
    var decl = node.declarations[i];
    c(decl.id, st, "Pattern");
    if (decl.init) c(decl.init, st, "Expression");
  }
};

base.Function = function (node, st, c) {
  for (var i = 0; i < node.params.length; i++) {
    c(node.params[i], st, "Pattern");
  }c(node.body, st, node.expression ? "ScopeExpression" : "ScopeBody");
};
// FIXME drop these node types in next major version
// (They are awkward, and in ES6 every block can be a scope.)
base.ScopeBody = function (node, st, c) {
  return c(node, st, "Statement");
};
base.ScopeExpression = function (node, st, c) {
  return c(node, st, "Expression");
};

base.Pattern = function (node, st, c) {
  if (node.type == "Identifier") c(node, st, "VariablePattern");else if (node.type == "MemberExpression") c(node, st, "MemberPattern");else c(node, st);
};
base.VariablePattern = ignore;
base.MemberPattern = skipThrough;
base.RestElement = function (node, st, c) {
  return c(node.argument, st, "Pattern");
};
base.ArrayPattern = function (node, st, c) {
  for (var i = 0; i < node.elements.length; ++i) {
    var elt = node.elements[i];
    if (elt) c(elt, st, "Pattern");
  }
};
base.ObjectPattern = function (node, st, c) {
  for (var i = 0; i < node.properties.length; ++i) {
    c(node.properties[i].value, st, "Pattern");
  }
};

base.Expression = skipThrough;
base.ThisExpression = base.Super = base.MetaProperty = ignore;
base.ArrayExpression = function (node, st, c) {
  for (var i = 0; i < node.elements.length; ++i) {
    var elt = node.elements[i];
    if (elt) c(elt, st, "Expression");
  }
};
base.ObjectExpression = function (node, st, c) {
  for (var i = 0; i < node.properties.length; ++i) {
    c(node.properties[i], st);
  }
};
base.FunctionExpression = base.ArrowFunctionExpression = base.FunctionDeclaration;
base.SequenceExpression = base.TemplateLiteral = function (node, st, c) {
  for (var i = 0; i < node.expressions.length; ++i) {
    c(node.expressions[i], st, "Expression");
  }
};
base.UnaryExpression = base.UpdateExpression = function (node, st, c) {
  c(node.argument, st, "Expression");
};
base.BinaryExpression = base.LogicalExpression = function (node, st, c) {
  c(node.left, st, "Expression");
  c(node.right, st, "Expression");
};
base.AssignmentExpression = base.AssignmentPattern = function (node, st, c) {
  c(node.left, st, "Pattern");
  c(node.right, st, "Expression");
};
base.ConditionalExpression = function (node, st, c) {
  c(node.test, st, "Expression");
  c(node.consequent, st, "Expression");
  c(node.alternate, st, "Expression");
};
base.NewExpression = base.CallExpression = function (node, st, c) {
  c(node.callee, st, "Expression");
  if (node.arguments) for (var i = 0; i < node.arguments.length; ++i) {
    c(node.arguments[i], st, "Expression");
  }
};
base.MemberExpression = function (node, st, c) {
  c(node.object, st, "Expression");
  if (node.computed) c(node.property, st, "Expression");
};
base.ExportNamedDeclaration = base.ExportDefaultDeclaration = function (node, st, c) {
  if (node.declaration) c(node.declaration, st);
};
base.ImportDeclaration = function (node, st, c) {
  for (var i = 0; i < node.specifiers.length; i++) {
    c(node.specifiers[i], st);
  }
};
base.ImportSpecifier = base.ImportDefaultSpecifier = base.ImportNamespaceSpecifier = base.Identifier = base.Literal = ignore;

base.TaggedTemplateExpression = function (node, st, c) {
  c(node.tag, st, "Expression");
  c(node.quasi, st);
};
base.ClassDeclaration = base.ClassExpression = function (node, st, c) {
  return c(node, st, "Class");
};
base.Class = function (node, st, c) {
  if (node.id) c(node.id, st, "Pattern");
  if (node.superClass) c(node.superClass, st, "Expression");
  for (var i = 0; i < node.body.body.length; i++) {
    c(node.body.body[i], st);
  }
};
base.MethodDefinition = base.Property = function (node, st, c) {
  if (node.computed) c(node.key, st, "Expression");
  c(node.value, st, "Expression");
};
base.ComprehensionExpression = function (node, st, c) {
  for (var i = 0; i < node.blocks.length; i++) {
    c(node.blocks[i].right, st, "Expression");
  }c(node.body, st, "Expression");
};

},{}]},{},[1])(1)
});
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],17:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],18:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            currentQueue[queueIndex].run();
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],19:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],20:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./support/isBuffer":19,"_process":18,"inherits":17}]},{},[8])(8)
});
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCIvaG9tZS9zd2tpbS9XZWJzdG9ybVByb2plY3RzL3lhdGVybi9saWIvYXV4LmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2NvbnN0cmFpbnQvY0dlbi5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi9jb25zdHJhaW50L2NvbnN0cmFpbnRzLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2RvbWFpbnMvY29udGV4dC5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi9kb21haW5zL3N0YXR1cy5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi9kb21haW5zL3R5cGVzLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2dldFR5cGVEYXRhLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL2luZmVyLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3JldE9jY3VyLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3RoaXNPY2N1ci5qcyIsIi9ob21lL3N3a2ltL1dlYnN0b3JtUHJvamVjdHMveWF0ZXJuL2xpYi91dGlsL215V2Fsa2VyLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3ZhckJsb2NrLmpzIiwiL2hvbWUvc3draW0vV2Vic3Rvcm1Qcm9qZWN0cy95YXRlcm4vbGliL3ZhcnJlZnMuanMiLCJub2RlX21vZHVsZXMvYWNvcm4vZGlzdC9hY29ybi5qcyIsIm5vZGVfbW9kdWxlcy9hY29ybi9kaXN0L2Fjb3JuX2xvb3NlLmpzIiwibm9kZV9tb2R1bGVzL2Fjb3JuL2Rpc3Qvd2Fsay5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9pbmhlcml0cy9pbmhlcml0c19icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyIsIm5vZGVfbW9kdWxlcy9icm93c2VyaWZ5L25vZGVfbW9kdWxlcy91dGlsL3N1cHBvcnQvaXNCdWZmZXJCcm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3V0aWwvdXRpbC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7O0FDQUEsSUFBSSxJQUFJLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDOztBQUUzQixTQUFTLFdBQVcsQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFO0FBQ2hDLFFBQUksUUFBUSxHQUFHLEVBQUUsQ0FBQzs7QUFFbEIsUUFBSSxHQUFHLEdBQUcsUUFBUSxLQUFLLFNBQVMsR0FBRyxDQUFDLEdBQUcsUUFBUSxDQUFDOztBQUVoRCxhQUFTLFFBQVEsQ0FBQyxJQUFJLEVBQUU7QUFDcEIsWUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLEdBQUcsQ0FBQztBQUNyQixnQkFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNwQixXQUFHLEVBQUUsQ0FBQztLQUNUOzs7QUFHRCxhQUFTLGlCQUFpQixDQUFDLElBQUksRUFBRTtBQUM3QixZQUFJLElBQUksSUFBSSxJQUFJLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxFQUFFO0FBQ3JDLG9CQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7U0FDbEI7QUFDRCxZQUFJLElBQUksSUFBSSxPQUFPLElBQUksS0FBSyxRQUFRLEVBQUU7QUFDbEMsaUJBQUssSUFBSSxDQUFDLElBQUksSUFBSSxFQUFFO0FBQ2hCLGlDQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO2FB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QUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ2p2R0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7QUN6dERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDalhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCJ2YXIgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxuZnVuY3Rpb24gZ2V0Tm9kZUxpc3QoYXN0LCBzdGFydE51bSkge1xuICAgIHZhciBub2RlTGlzdCA9IFtdO1xuXG4gICAgdmFyIG51bSA9IHN0YXJ0TnVtID09PSB1bmRlZmluZWQgPyAwIDogc3RhcnROdW07XG5cbiAgICBmdW5jdGlvbiBhc3NpZ25JZChub2RlKSB7XG4gICAgICAgIG5vZGVbJ0BsYWJlbCddID0gbnVtO1xuICAgICAgICBub2RlTGlzdC5wdXNoKG5vZGUpO1xuICAgICAgICBudW0rKztcbiAgICB9XG5cbiAgICAvLyBMYWJlbCBldmVyeSBBU1Qgbm9kZSB3aXRoIHByb3BlcnR5ICd0eXBlJ1xuICAgIGZ1bmN0aW9uIGxhYmVsTm9kZVdpdGhUeXBlKG5vZGUpIHtcbiAgICAgICAgaWYgKG5vZGUgJiYgbm9kZS5oYXNPd25Qcm9wZXJ0eSgndHlwZScpKSB7XG4gICAgICAgICAgICBhc3NpZ25JZChub2RlKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobm9kZSAmJiB0eXBlb2Ygbm9kZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIGZvciAodmFyIHAgaW4gbm9kZSkge1xuICAgICAgICAgICAgICAgIGxhYmVsTm9kZVdpdGhUeXBlKG5vZGVbcF0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgbGFiZWxOb2RlV2l0aFR5cGUoYXN0KTtcblxuICAgIHJldHVybiBub2RlTGlzdDtcbn1cblxuZnVuY3Rpb24gc2hvd1VuZm9sZGVkKG9iaikge1xuICAgIGNvbnNvbGUubG9nKHV0aWwuaW5zcGVjdChvYmosIHtkZXB0aDogbnVsbH0pKTtcbn1cblxuZXhwb3J0cy5nZXROb2RlTGlzdCA9IGdldE5vZGVMaXN0O1xuZXhwb3J0cy5zaG93VW5mb2xkZWQgPSBzaG93VW5mb2xkZWQ7XG4iLCIndXNlIHN0cmljdCc7XG5cbmNvbnN0IHR5cGVzID0gcmVxdWlyZSgnLi4vZG9tYWlucy90eXBlcycpO1xuY29uc3Qgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xuY29uc3Qgc3RhdHVzID0gcmVxdWlyZSgnLi4vZG9tYWlucy9zdGF0dXMnKTtcbmNvbnN0IGNzdHIgPSByZXF1aXJlKCcuL2NvbnN0cmFpbnRzJyk7XG5cbi8vIGFyZ3VtZW50cyBhcmUgXCIgb2xkU3RhdHVzICgsIG5hbWUsIHZhbCkqIFwiXG5mdW5jdGlvbiBjaGFuZ2VkU3RhdHVzKG9sZFN0YXR1cykge1xuICAgIGNvbnN0IG5ld1N0YXR1cyA9IG5ldyBzdGF0dXMuU3RhdHVzO1xuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSA9IGkgKyAyKVxuICAgICAgICBuZXdTdGF0dXNbYXJndW1lbnRzW2ldXSA9IGFyZ3VtZW50c1tpKzFdO1xuXG4gICAgZm9yIChsZXQgcCBpbiBvbGRTdGF0dXMpIHtcbiAgICAgICAgaWYgKG5ld1N0YXR1c1twXSA9PT0gdW5kZWZpbmVkKVxuICAgICAgICAgICAgbmV3U3RhdHVzW3BdID0gb2xkU3RhdHVzW3BdO1xuICAgIH1cbiAgICByZXR1cm4gbmV3U3RhdHVzO1xufVxuXG4vLyByZXR1cm5zIFthY2Nlc3MgdHlwZSwgcHJvcCB2YWx1ZV1cbmZ1bmN0aW9uIHByb3BBY2Nlc3Mobm9kZSkge1xuICAgIGNvbnN0IHByb3AgPSBub2RlLnByb3BlcnR5O1xuICAgIGlmICghbm9kZS5jb21wdXRlZCkge1xuICAgICAgICByZXR1cm4gWydkb3RBY2Nlc3MnLCBwcm9wLm5hbWVdO1xuICAgIH1cbiAgICBpZiAocHJvcC50eXBlID09PSAnTGl0ZXJhbCcpIHtcbiAgICAgICAgaWYgKHR5cGVvZiBwcm9wLnZhbHVlID09PSAnc3RyaW5nJylcbiAgICAgICAgICAgIHJldHVybiBbJ3N0cmluZ0xpdGVyYWwnLCBwcm9wLnZhbHVlXTtcbiAgICAgICAgaWYgKHR5cGVvZiBwcm9wLnZhbHVlID09PSAnbnVtYmVyJylcbiAgICAgICAgICAgIC8vIGNvbnZlcnQgbnVtYmVyIHRvIHN0cmluZ1xuICAgICAgICAgICAgcmV0dXJuIFsnbnVtYmVyTGl0ZXJhbCcsIHByb3AudmFsdWUgKyAnJ107XG4gICAgfVxuICAgIHJldHVybiBbXCJjb21wdXRlZFwiLCBudWxsXTtcbn1cblxuZnVuY3Rpb24gdW5vcFJlc3VsdFR5cGUob3ApIHtcbiAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgIGNhc2UgJysnOiBjYXNlICctJzogY2FzZSAnfic6XG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuUHJpbU51bWJlcjtcbiAgICAgICAgY2FzZSAnISc6XG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuUHJpbUJvb2xlYW47XG4gICAgICAgIGNhc2UgJ3R5cGVvZic6XG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuUHJpbVN0cmluZztcbiAgICAgICAgY2FzZSAndm9pZCc6IGNhc2UgJ2RlbGV0ZSc6XG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGJpbm9wSXNCb29sZWFuKG9wKSB7XG4gICAgc3dpdGNoIChvcCkge1xuICAgICAgICBjYXNlICc9PSc6IGNhc2UgJyE9JzogY2FzZSAnPT09JzogY2FzZSAnIT09JzpcbiAgICAgICAgY2FzZSAnPCc6IGNhc2UgJz4nOiBjYXNlICc+PSc6IGNhc2UgJzw9JzpcbiAgICAgICAgY2FzZSAnaW4nOiBjYXNlICdpbnN0YW5jZW9mJzpcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG59XG5cbi8vIFRvIHByZXZlbnQgcmVjdXJzaW9uLFxuLy8gd2UgcmVtZW1iZXIgdGhlIHN0YXR1cyB1c2VkIGluIGFkZENvbnN0cmFpbnRzXG5jb25zdCB2aXNpdGVkU3RhdHVzID0gW107XG5jb25zdCBjb25zdHJhaW50cyA9IFtdO1xuZnVuY3Rpb24gY2xlYXJDb25zdHJhaW50cygpIHtcbiAgICB2aXNpdGVkU3RhdHVzLmxlbmd0aCA9IDA7XG4gICAgY29uc3RyYWludHMubGVuZ3RoID0gMDtcbn1cblxubGV0IHJ0Q1g7XG5mdW5jdGlvbiBhZGRDb25zdHJhaW50cyhhc3QsIGluaXRTdGF0dXMsIG5ld1J0Q1gpIHtcblxuICAgIC8vIHNldCBydENYXG4gICAgcnRDWCA9IG5ld1J0Q1ggfHwgcnRDWDtcbiAgICBjb25zdCDEiCA9IHJ0Q1guxIg7XG5cbiAgICAvLyBDaGVjayB3aGV0aGVyIHdlIGhhdmUgcHJvY2Vzc2VkICdpbml0U3RhdHVzJyBiZWZvcmVcbiAgICBmb3IgKGxldCBpPTA7IGkgPCB2aXNpdGVkU3RhdHVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChpbml0U3RhdHVzLmVxdWFscyh2aXNpdGVkU3RhdHVzW2ldKSkge1xuICAgICAgICAgICAgIC8vIElmIHNvLCBkbyBub3RoaW5nXG4gICAgICAgICAgICAgLy8gc2lnbmlmeWluZyB3ZSBkaWRuJ3QgYWRkIGNvbnN0cmFpbnRzXG4gICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgfVxuICAgIH1cbiAgICAvLyBJZiB0aGUgaW5pdFN0YXR1cyBpcyBuZXcsIHB1c2ggaXQuXG4gICAgLy8gV2UgZG8gbm90IHJlY29yZCBhc3Qgc2luY2UgYXN0IG5vZGUgZGVwZW5kcyBvbiB0aGUgc3RhdHVzXG4gICAgdmlzaXRlZFN0YXR1cy5wdXNoKGluaXRTdGF0dXMpO1xuXG4gICAgZnVuY3Rpb24gcmVhZE1lbWJlcihub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgY29uc3QgcmV0ID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgIGNvbnN0IG9iakFWYWwgPSBjKG5vZGUub2JqZWN0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgIGlmIChub2RlLnByb3BlcnR5LnR5cGUgIT09ICdJZGVudGlmaWVyJykge1xuICAgICAgICAgICAgLy8gcmV0dXJuIGZyb20gcHJvcGVydHkgaXMgaWdub3JlZFxuICAgICAgICAgICAgYyhub2RlLnByb3BlcnR5LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgWywgcHJvcE5hbWVdID0gcHJvcEFjY2Vzcyhub2RlKTtcblxuICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtPQko6IG9iakFWYWwsXG4gICAgICAgICAgICBQUk9QOiBwcm9wTmFtZSxcbiAgICAgICAgICAgIFJFQURfVE86IHJldH0pO1xuICAgICAgICBvYmpBVmFsLnByb3BhZ2F0ZShuZXcgY3N0ci5SZWFkUHJvcChwcm9wTmFtZSwgcmV0KSk7XG5cbiAgICAgICAgLy8gcmV0dXJucyBBVmFsIGZvciByZWNlaXZlciBhbmQgcmVhZCBtZW1iZXJcbiAgICAgICAgcmV0dXJuIFtvYmpBVmFsLCByZXRdO1xuICAgIH1cblxuICAgIC8vIGNvbnN0cmFpbnQgZ2VuZXJhdGluZyB3YWxrZXIgZm9yIGV4cHJlc3Npb25zXG4gICAgY29uc3QgY29uc3RyYWludEdlbmVyYXRvciA9IHdhbGsubWFrZSh7XG5cbiAgICAgICAgSWRlbnRpZmllcjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgYXYgPSBjdXJTdGF0dXMuc2MuZ2V0QVZhbE9mKG5vZGUubmFtZSk7XG4gICAgICAgICAgICAvLyB1c2UgYXZhbCBpbiB0aGUgc2NvcGVcbiAgICAgICAgICAgIMSILnNldChub2RlLCBjdXJTdGF0dXMuZGVsdGEsIGF2KTtcbiAgICAgICAgICAgIHJldHVybiBhdjtcbiAgICAgICAgfSxcblxuICAgICAgICBUaGlzRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgYXYgPSBjdXJTdGF0dXMuc2VsZjtcbiAgICAgICAgICAgIC8vIHVzZSBhdmFsIGZvciAndGhpcydcbiAgICAgICAgICAgIMSILnNldChub2RlLCBjdXJTdGF0dXMuZGVsdGEsIGF2KTtcbiAgICAgICAgICAgIHJldHVybiBhdjtcbiAgICAgICAgfSxcblxuICAgICAgICBMaXRlcmFsOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCByZXMgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIGlmIChub2RlLnJlZ2V4KSB7XG4gICAgICAgICAgICAgICAgLy8gbm90IGltcGxlbWVudGVkIHlldFxuICAgICAgICAgICAgICAgIC8vIHRocm93IG5ldyBFcnJvcigncmVnZXggbGl0ZXJhbCBpcyBub3QgaW1wbGVtZW50ZWQgeWV0Jyk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN3aXRjaCAodHlwZW9mIG5vZGUudmFsdWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogdHlwZXMuUHJpbU51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBJTkNMX1NFVDogcmVzfSk7XG4gICAgICAgICAgICAgICAgcmVzLmFkZFR5cGUodHlwZXMuUHJpbU51bWJlcik7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBjYXNlICdzdHJpbmcnOlxuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1RZUEU6IHR5cGVzLlByaW1TdHJpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgIHJlcy5hZGRUeXBlKHR5cGVzLlByaW1TdHJpbmcpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogdHlwZXMuUHJpbUJvb2xlYW4sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgIHJlcy5hZGRUeXBlKHR5cGVzLlByaW1Cb29sZWFuKTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICAgICAgLy8gSSBndWVzczogTGl0ZXJhbCAmJiBvYmplY3QgPT0+IG5vZGUudmFsdWUgPT0gbnVsbFxuICAgICAgICAgICAgICAgIC8vIG51bGwgaXMgaWdub3JlZCwgc28gbm90aGluZyB0byBhZGRcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIGNhc2UgJ2Z1bmN0aW9uJzpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0kgZ3Vlc3MgZnVuY3Rpb24gaXMgaW1wb3NzaWJsZSBoZXJlLicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgfSxcblxuICAgICAgICBBc3NpZ25tZW50RXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmhzQVZhbCA9IGMobm9kZS5yaWdodCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgaWYgKG5vZGUubGVmdC50eXBlID09PSAnSWRlbnRpZmllcicpIHtcbiAgICAgICAgICAgICAgICAvLyBMSFMgaXMgYSBzaW1wbGUgdmFyaWFibGUuXG4gICAgICAgICAgICAgICAgY29uc3QgdmFyTmFtZSA9IG5vZGUubGVmdC5uYW1lO1xuICAgICAgICAgICAgICAgIGNvbnN0IGxoc0FWYWwgPSBjdXJTdGF0dXMuc2MuZ2V0QVZhbE9mKHZhck5hbWUpO1xuICAgICAgICAgICAgICAgIC8vIGxocyBpcyBub3QgdmlzaXRlZC4gTmVlZCB0byBoYW5kbGUgaGVyZS5cbiAgICAgICAgICAgICAgICAvLyBVc2UgYXZhbCBmb3VuZCBpbiB0aGUgc2NvcGUgZm9yIGxoc1xuICAgICAgICAgICAgICAgIMSILnNldChub2RlLmxlZnQsIGN1clN0YXR1cy5kZWx0YSwgbGhzQVZhbCk7XG5cbiAgICAgICAgICAgICAgICBpZiAobm9kZS5vcGVyYXRvciA9PT0gJz0nKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHNpbXBsZSBhc3NpZ25tZW50XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgRlJPTTogcmhzQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIFRPOiBsaHNBVmFsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICByaHNBVmFsLnByb3BhZ2F0ZShsaHNBVmFsKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gbm9kZSdzIEFWYWwgZnJvbSBSSFNcbiAgICAgICAgICAgICAgICAgICAgxIguc2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSwgcmhzQVZhbCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByaHNBVmFsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyB1cGRhdGluZyBhc3NpZ25tZW50XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzQVZhbCA9IMSILmdldChub2RlLCBjdXJTdGF0dXMuZGVsdGEpO1xuICAgICAgICAgICAgICAgIGlmIChub2RlLm9wZXJhdG9yID09PSAnKz0nKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGNvbmNhdGVuYXRpbmcgdXBkYXRlXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgQUREX09QUkQxOiBsaHNBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgQUREX09QUkQyOiByaHNBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgUkVTVUxUOiByZXNBVmFsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBsaHNBVmFsLnByb3BhZ2F0ZShuZXcgY3N0ci5Jc0FkZGVkKHJoc0FWYWwsIHJlc0FWYWwpKTtcbiAgICAgICAgICAgICAgICAgICAgcmhzQVZhbC5wcm9wYWdhdGUobmV3IGNzdHIuSXNBZGRlZChsaHNBVmFsLCByZXNBVmFsKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXJpdGhtZXRpYyB1cGRhdGVcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICBUWVBFOnR5cGVzLlByaW1OdW1iZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICBJTkNMX1NFVDogcmVzQVZhbFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgcmVzQVZhbC5hZGRUeXBlKHR5cGVzLlByaW1OdW1iZXIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzQVZhbDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAobm9kZS5sZWZ0LnR5cGUgPT09ICdNZW1iZXJFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIGNvbnN0IG9iakFWYWwgPSBjKG5vZGUubGVmdC5vYmplY3QsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgICAgICBjb25zdCBbYWNjVHlwZSwgcHJvcE5hbWVdID0gcHJvcEFjY2Vzcyhub2RlLmxlZnQpO1xuICAgICAgICAgICAgICAgIGlmIChub2RlLm9wZXJhdG9yID09PSAnPScpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXNzaWdubWVudCB0byBtZW1iZXJcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgICAgICBPQko6IG9iakFWYWwsXG4gICAgICAgICAgICAgICAgICAgICAgICBQUk9QOiBwcm9wTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIFdSSVRFX1dJVEg6IHJoc0FWYWxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIG9iakFWYWwucHJvcGFnYXRlKG5ldyBjc3RyLldyaXRlUHJvcChwcm9wTmFtZSwgcmhzQVZhbCkpO1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiBwcm9wZXJ0eSBpcyBudW1iZXIgbGl0ZXJhbCwgYWxzbyB3cml0ZSB0byAndW5rbm93bidcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFjY1R5cGUgPT09ICdudW1iZXJMaXRlcmFsJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqQVZhbC5wcm9wYWdhdGUobmV3IGNzdHIuV3JpdGVQcm9wKG51bGwsIHJoc0FWYWwpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAvLyBub2RlJ3MgQVZhbCBmcm9tIFJIU1xuICAgICAgICAgICAgICAgICAgICDEiC5zZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhLCByaHNBVmFsKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJoc0FWYWw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIC8vIHVwZGF0aW5nIGFzc2lnbm1lbnRcbiAgICAgICAgICAgICAgICBjb25zdCByZXNBVmFsID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICAgICAgY29uc3QgWywgcmV0QVZhbF0gPSByZWFkTWVtYmVyKG5vZGUubGVmdCwgY3VyU3RhdHVzLCBjKTtcbiAgICAgICAgICAgICAgICBpZiAobm9kZS5vcGVyYXRvciA9PT0gJys9Jykge1xuICAgICAgICAgICAgICAgICAgICAvLyBjb25jYXRlbmF0aW5nIHVwZGF0ZVxuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIEFERF9PUFJEMTogcmV0QVZhbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIEFERF9PUFJEMjogcmhzQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgICAgIFJFU1VMVDogcmVzQVZhbFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgcmV0QVZhbC5wcm9wYWdhdGUobmV3IGNzdHIuSXNBZGRlZChyaHNBVmFsLCByZXNBVmFsKSk7XG4gICAgICAgICAgICAgICAgICAgIHJoc0FWYWwucHJvcGFnYXRlKG5ldyBjc3RyLklzQWRkZWQocmV0QVZhbCwgcmVzQVZhbCkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFyaXRobWV0aWMgdXBkYXRlXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgICAgICAgICAgVFlQRTogdHlwZXMuUHJpbU51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiByZXNBVmFsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICByZXNBVmFsLmFkZFR5cGUodHlwZXMuUHJpbU51bWJlcik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiByZXNBVmFsO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmluZm8oJ0Fzc2lnbm1lbnQgdXNpbmcgcGF0dGVybiBpcyBub3QgaW1wbGVtZW50ZWQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBWYXJpYWJsZURlY2xhcmF0aW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUuZGVjbGFyYXRpb25zLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVjbCA9IG5vZGUuZGVjbGFyYXRpb25zW2ldO1xuICAgICAgICAgICAgICAgIGNvbnN0IGxoc0FWYWwgPSBjdXJTdGF0dXMuc2MuZ2V0QVZhbE9mKGRlY2wuaWQubmFtZSk7XG4gICAgICAgICAgICAgICAgLy8gZGVjbGFyZWQgdmFyIG5vZGUgaXMgJ2lkJ1xuICAgICAgICAgICAgICAgIMSILnNldChkZWNsLmlkLCBjdXJTdGF0dXMuZGVsdGEsIGxoc0FWYWwpO1xuICAgICAgICAgICAgICAgIGlmIChkZWNsLmluaXQpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmhzQVZhbCA9IGMoZGVjbC5pbml0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICAgICAgICAgIMSILnNldChkZWNsLmluaXQsIGN1clN0YXR1cy5kZWx0YSwgcmhzQVZhbCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe0ZST006IHJoc0FWYWwsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFRPOiBsaHNBVmFsfSk7XG4gICAgICAgICAgICAgICAgICAgIHJoc0FWYWwucHJvcGFnYXRlKGxoc0FWYWwpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSxcblxuICAgICAgICBMb2dpY2FsRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICBjb25zdCBsZWZ0ID0gYyhub2RlLmxlZnQsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgIGNvbnN0IHJpZ2h0ID0gYyhub2RlLnJpZ2h0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtGUk9NOiBsZWZ0LCBUTzogcmVzfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAge0ZST006IHJpZ2h0LCBUTzogcmVzfSk7XG4gICAgICAgICAgICBsZWZ0LnByb3BhZ2F0ZShyZXMpO1xuICAgICAgICAgICAgcmlnaHQucHJvcGFnYXRlKHJlcyk7XG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9LFxuXG4gICAgICAgIENvbmRpdGlvbmFsRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmVzID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICBjKG5vZGUudGVzdCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc3QgY29ucyA9IGMobm9kZS5jb25zZXF1ZW50LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCBhbHQgPSBjKG5vZGUuYWx0ZXJuYXRlLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtGUk9NOiBjb25zLCBUTzogcmVzfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAge0ZST006IGFsdCwgVE86IHJlc30pO1xuICAgICAgICAgICAgY29ucy5wcm9wYWdhdGUocmVzKTtcbiAgICAgICAgICAgIGFsdC5wcm9wYWdhdGUocmVzKTtcbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgIH0sXG5cbiAgICAgICAgTmV3RXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgY29uc3QgcmV0ID0gxIguZ2V0KG5vZGUsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICBjb25zdCBjYWxsZWUgPSBjKG5vZGUuY2FsbGVlLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCBhcmdzID0gW107XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUuYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgYXJncy5wdXNoKGMobm9kZS5hcmd1bWVudHNbaV0sIGN1clN0YXR1cywgdW5kZWZpbmVkKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBuZXdEZWx0YSA9IGN1clN0YXR1cy5kZWx0YS5hcHBlbmRPbmUobm9kZVsnQGxhYmVsJ10pO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7Q09OU1RSVUNUT1I6IGNhbGxlZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEFSR1M6IGFyZ3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBSRVQ6IHJldCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIEVYQzogY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIERFTFRBOiBuZXdEZWx0YX0pO1xuICAgICAgICAgICAgY2FsbGVlLnByb3BhZ2F0ZShcbiAgICAgICAgICAgICAgICBuZXcgY3N0ci5Jc0N0b3IoXG4gICAgICAgICAgICAgICAgICAgIGFyZ3MsXG4gICAgICAgICAgICAgICAgICAgIHJldCxcbiAgICAgICAgICAgICAgICAgICAgY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAgICAgbmV3RGVsdGEpKTtcbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH0sXG5cbiAgICAgICAgQXJyYXlFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCByZXQgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgIGNvbnN0IGFyclR5cGUgPSBuZXcgdHlwZXMuQXJyVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5BcnJheSkpO1xuICAgICAgICAgICAgLy8gYWRkIGxlbmd0aCBwcm9wZXJ0eVxuICAgICAgICAgICAgYXJyVHlwZS5nZXRQcm9wKCdsZW5ndGgnKS5hZGRUeXBlKHR5cGVzLlByaW1OdW1iZXIpO1xuXG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBhcnJUeXBlLCBJTkNMX1NFVDogcmV0fSk7XG4gICAgICAgICAgICByZXQuYWRkVHlwZShhcnJUeXBlKTtcblxuICAgICAgICAgICAgLy8gYWRkIGFycmF5IGVsZW1lbnRzXG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUuZWxlbWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBjb25zdCBlbHRBVmFsID0gYyhub2RlLmVsZW1lbnRzW2ldLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG5cbiAgICAgICAgICAgICAgICBjb25zdCBwcm9wID0gaSArICcnO1xuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe09CSjogcmV0LCBQUk9QOiBwcm9wLCBBVkFMOiBlbHRBVmFsfSk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7T0JKOiByZXQsIFBST1A6IG51bGwsIEFWQUw6IGVsdEFWYWx9KTtcbiAgICAgICAgICAgICAgICByZXQucHJvcGFnYXRlKG5ldyBjc3RyLldyaXRlUHJvcChwcm9wLCBlbHRBVmFsKSk7XG4gICAgICAgICAgICAgICAgcmV0LnByb3BhZ2F0ZShuZXcgY3N0ci5Xcml0ZVByb3AobnVsbCwgZWx0QVZhbCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfSxcblxuICAgICAgICBPYmplY3RFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCByZXQgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgIGNvbnN0IG9ialR5cGUgPSBuZXcgdHlwZXMuT2JqVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5PYmplY3QpKTtcbiAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1RZUEU6IG9ialR5cGUsIElOQ0xfU0VUOiByZXR9KTtcbiAgICAgICAgICAgIHJldC5hZGRUeXBlKG9ialR5cGUpO1xuXG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IG5vZGUucHJvcGVydGllcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHByb3BQYWlyID0gbm9kZS5wcm9wZXJ0aWVzW2ldO1xuICAgICAgICAgICAgICAgIGNvbnN0IHByb3BLZXkgPSBwcm9wUGFpci5rZXk7XG4gICAgICAgICAgICAgICAgbGV0IG5hbWU7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvcEV4cHIgPSBwcm9wUGFpci52YWx1ZTtcblxuICAgICAgICAgICAgICAgIGNvbnN0IGZsZEFWYWwgPSBjKHByb3BFeHByLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcEtleS50eXBlID09PSAnSWRlbnRpZmllcicpIHtcbiAgICAgICAgICAgICAgICAgICAgbmFtZSA9IHByb3BLZXkubmFtZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBwcm9wS2V5LnZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBuYW1lID0gcHJvcEtleS52YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBwcm9wS2V5LnZhbHVlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICAvLyBjb252ZXJ0IG51bWJlciB0byBzdHJpbmdcbiAgICAgICAgICAgICAgICAgICAgbmFtZSA9IHByb3BLZXkudmFsdWUgKyAnJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7T0JKOiByZXQsIFBST1A6IG5hbWUsIEFWQUw6IGZsZEFWYWx9KTtcbiAgICAgICAgICAgICAgICByZXQucHJvcGFnYXRlKG5ldyBjc3RyLldyaXRlUHJvcChuYW1lLCBmbGRBVmFsKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9LFxuXG4gICAgICAgIEZ1bmN0aW9uRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgaWYgKCFub2RlLmZuSW5zdGFuY2VzKSB7XG4gICAgICAgICAgICAgICAgbm9kZS5mbkluc3RhbmNlcyA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IGZuSW5zdGFuY2UgPSBudWxsO1xuICAgICAgICAgICAgbm9kZS5mbkluc3RhbmNlcy5mb3JFYWNoKGZ1bmN0aW9uIChmblR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm5UeXBlLnNjID09PSBjdXJTdGF0dXMuc2MpIHtcbiAgICAgICAgICAgICAgICAgICAgZm5JbnN0YW5jZSA9IGZuVHlwZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGlmICghZm5JbnN0YW5jZSkge1xuICAgICAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgICAgICBmbkluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgID0gbmV3IHR5cGVzLkZuVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5GdW5jdGlvbiksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnW2Fub255bW91cyBmdW5jdGlvbl0nLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZS5ib2R5WydAYmxvY2snXS5nZXRQYXJhbVZhck5hbWVzKCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjdXJTdGF0dXMuc2MsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcnRDWC5wcm90b3MuT2JqZWN0KTtcbiAgICAgICAgICAgICAgICBub2RlLmZuSW5zdGFuY2VzLnB1c2goZm5JbnN0YW5jZSk7XG4gICAgICAgICAgICAgICAgLy8gTk9URSBwcm90b3R5cGUgb2JqZWN0IGlzIG5vdCByZWNvcmRlZCBpbiDEiFxuICAgICAgICAgICAgICAgIGNvbnN0IHByb3RvdHlwZU9iamVjdCA9XG4gICAgICAgICAgICAgICAgICAgIG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKHJ0Q1gucHJvdG9zLk9iamVjdCksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICc/LnByb3RvdHlwZScpO1xuICAgICAgICAgICAgICAgIC8vIEZvciAucHJvdG90eXBlXG4gICAgICAgICAgICAgICAgY29uc3QgcHJvdG90eXBlUHJvcCA9IGZuSW5zdGFuY2UuZ2V0UHJvcCgncHJvdG90eXBlJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogcHJvdG90eXBlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBwcm90b3R5cGVQcm9wfSk7XG4gICAgICAgICAgICAgICAgcHJvdG90eXBlUHJvcC5hZGRUeXBlKHByb3RvdHlwZU9iamVjdCk7XG4gICAgICAgICAgICAgICAgLy8gRm9yIC5wcm90b3R5cGUuY29uc3RydWN0b3JcbiAgICAgICAgICAgICAgICBjb25zdCBjb25zdHJ1Y3RvclByb3AgPSBwcm90b3R5cGVPYmplY3QuZ2V0UHJvcCgnY29uc3RydWN0b3InKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBmbkluc3RhbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBjb25zdHJ1Y3RvclByb3B9KTtcbiAgICAgICAgICAgICAgICBjb25zdHJ1Y3RvclByb3AuYWRkVHlwZShmbkluc3RhbmNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJldCA9IMSILmdldChub2RlLCBjdXJTdGF0dXMuZGVsdGEpO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogZm5JbnN0YW5jZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiByZXR9KTtcbiAgICAgICAgICAgIHJldC5hZGRUeXBlKGZuSW5zdGFuY2UpO1xuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfSxcblxuICAgICAgICBGdW5jdGlvbkRlY2xhcmF0aW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICAvLyBEcm9wIGluaXRpYWwgY2F0Y2ggc2NvcGVzXG4gICAgICAgICAgICBjb25zdCBzYzAgPSBjdXJTdGF0dXMuc2MucmVtb3ZlSW5pdGlhbENhdGNoQmxvY2tzKCk7XG4gICAgICAgICAgICBpZiAoIW5vZGUuZm5JbnN0YW5jZXMpIHtcbiAgICAgICAgICAgICAgICBub2RlLmZuSW5zdGFuY2VzID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgZm5JbnN0YW5jZSA9IG51bGw7XG4gICAgICAgICAgICBub2RlLmZuSW5zdGFuY2VzLmZvckVhY2goZnVuY3Rpb24gKGZuVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmIChmblR5cGUuc2MgPT09IHNjMCkge1xuICAgICAgICAgICAgICAgICAgICBmbkluc3RhbmNlID0gZm5UeXBlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgaWYgKCFmbkluc3RhbmNlKSB7XG4gICAgICAgICAgICAgICAgLy8gTk9URSBwcm90b3R5cGUgb2JqZWN0IGlzIG5vdCByZWNvcmRlZCBpbiDEiFxuICAgICAgICAgICAgICAgIGZuSW5zdGFuY2VcbiAgICAgICAgICAgICAgICAgICAgPSBuZXcgdHlwZXMuRm5UeXBlKG5ldyB0eXBlcy5BVmFsKHJ0Q1gucHJvdG9zLkZ1bmN0aW9uKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuaWQubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG5vZGUuYm9keVsnQGJsb2NrJ10uZ2V0UGFyYW1WYXJOYW1lcygpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2MwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbm9kZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ0Q1gucHJvdG9zLk9iamVjdCk7XG4gICAgICAgICAgICAgICAgbm9kZS5mbkluc3RhbmNlcy5wdXNoKGZuSW5zdGFuY2UpO1xuICAgICAgICAgICAgICAgIC8vIGZvciBlYWNoIGZuSW5zdGFuY2UsIGFzc2lnbiBvbmUgcHJvdG90eXBlIG9iamVjdFxuICAgICAgICAgICAgICAgIC8vIE5PVEUgcHJvdG90eXBlIG9iamVjdCBpcyBub3QgcmVjb3JkZWQgaW4gxIhcbiAgICAgICAgICAgICAgICBjb25zdCBwcm90b3R5cGVPYmplY3QgPVxuICAgICAgICAgICAgICAgICAgICBuZXcgdHlwZXMuT2JqVHlwZShuZXcgdHlwZXMuQVZhbChydENYLnByb3Rvcy5PYmplY3QpLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBub2RlLmlkLm5hbWUgKyAnLnByb3RvdHlwZScpO1xuICAgICAgICAgICAgICAgIC8vIEZvciAucHJvdG90eXBlXG4gICAgICAgICAgICAgICAgY29uc3QgcHJvdG90eXBlUHJvcCA9IGZuSW5zdGFuY2UuZ2V0UHJvcCgncHJvdG90eXBlJyk7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogcHJvdG90eXBlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBwcm90b3R5cGVQcm9wfSk7XG4gICAgICAgICAgICAgICAgcHJvdG90eXBlUHJvcC5hZGRUeXBlKHByb3RvdHlwZU9iamVjdCk7XG4gICAgICAgICAgICAgICAgLy8gRm9yIC5wcm90b3R5cGUuY29uc3RydWN0b3JcbiAgICAgICAgICAgICAgICBjb25zdCBjb25zdHJ1Y3RvclByb3AgPSBwcm90b3R5cGVPYmplY3QuZ2V0UHJvcCgnY29uc3RydWN0b3InKTtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBmbkluc3RhbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiBjb25zdHJ1Y3RvclByb3B9KTtcbiAgICAgICAgICAgICAgICBjb25zdHJ1Y3RvclByb3AuYWRkVHlwZShmbkluc3RhbmNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGxoc0FWYWwgPSBzYzAuZ2V0QVZhbE9mKG5vZGUuaWQubmFtZSk7XG4gICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiBmbkluc3RhbmNlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IGxoc0FWYWx9KTtcbiAgICAgICAgICAgIGxoc0FWYWwuYWRkVHlwZShmbkluc3RhbmNlKTtcbiAgICAgICAgICAgIC8vIG5vdGhpbmcgdG8gcmV0dXJuXG4gICAgICAgICAgICByZXR1cm4gdHlwZXMuQVZhbE51bGw7XG4gICAgICAgIH0sXG5cbiAgICAgICAgU2VxdWVuY2VFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjb25zdCBsYXN0SW5kZXggPSBub2RlLmV4cHJlc3Npb25zLmxlbmd0aCAtIDE7XG4gICAgICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxhc3RJbmRleDsgaSsrKSB7XG4gICAgICAgICAgICAgICAgYyhub2RlLmV4cHJlc3Npb25zW2ldLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBsYXN0QVZhbCA9IGMobm9kZS5leHByZXNzaW9uc1tsYXN0SW5kZXhdLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICDEiC5zZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhLCBsYXN0QVZhbCk7XG4gICAgICAgICAgICByZXR1cm4gbGFzdEFWYWw7XG4gICAgICAgIH0sXG5cbiAgICAgICAgVW5hcnlFeHByZXNzaW9uOiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBjKG5vZGUuYXJndW1lbnQsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgIGNvbnN0IHJlcyA9IMSILmdldChub2RlLCBjdXJTdGF0dXMuZGVsdGEpO1xuICAgICAgICAgICAgY29uc3QgdHlwZSA9IHVub3BSZXN1bHRUeXBlKG5vZGUub3BlcmF0b3IpO1xuICAgICAgICAgICAgaWYgKHR5cGUpIHtcbiAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiB0eXBlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIElOQ0xfU0VUOiByZXN9KTtcbiAgICAgICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgIH0sXG5cbiAgICAgICAgVXBkYXRlRXhwcmVzc2lvbjogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgYyhub2RlLmFyZ3VtZW50LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCByZXMgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIGNvbnN0cmFpbnRzLnB1c2goe1RZUEU6IHR5cGVzLlByaW1OdW1iZXIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBJTkNMX1NFVDogcmVzfSk7XG4gICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICAgICAgICAgIC8vIFdlIGlnbm9yZSB0aGUgZWZmZWN0IG9mIHVwZGF0aW5nIHRvIG51bWJlciB0eXBlXG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9LFxuXG4gICAgICAgIEJpbmFyeUV4cHJlc3Npb246IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IGxPcHJkID0gYyhub2RlLmxlZnQsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgIGNvbnN0IHJPcHJkID0gYyhub2RlLnJpZ2h0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICBjb25zdCByZXMgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcblxuICAgICAgICAgICAgaWYgKG5vZGUub3BlcmF0b3IgPT0gJysnKSB7XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7QUREX09QUkQxOiBsT3ByZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBBRERfT1BSRDI6IHJPcHJkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFJFU1VMVDogcmVzIH0pO1xuICAgICAgICAgICAgICAgIGxPcHJkLnByb3BhZ2F0ZShuZXcgY3N0ci5Jc0FkZGVkKHJPcHJkLCByZXMpKTtcbiAgICAgICAgICAgICAgICByT3ByZC5wcm9wYWdhdGUobmV3IGNzdHIuSXNBZGRlZChsT3ByZCwgcmVzKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChiaW5vcElzQm9vbGVhbihub2RlLm9wZXJhdG9yKSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5wdXNoKHtUWVBFOiB0eXBlcy5QcmltQm9vbGVhbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlcy5QcmltQm9vbGVhbik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7VFlQRTogdHlwZXMuUHJpbU51bWJlcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgSU5DTF9TRVQ6IHJlc30pO1xuICAgICAgICAgICAgICAgICAgICByZXMuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICB9LFxuXG4gICAgICAgIFRyeVN0YXRlbWVudDogZnVuY3Rpb24gKG5vZGUsIGN1clN0YXR1cywgYykge1xuICAgICAgICAgICAgLy8gY29uc3RydWN0IHNjb3BlIGNoYWluIGZvciBjYXRjaCBibG9ja1xuICAgICAgICAgICAgY29uc3QgY2F0Y2hCbG9ja1NDID1cbiAgICAgICAgICAgICAgICBub2RlLmhhbmRsZXIuYm9keVsnQGJsb2NrJ11cbiAgICAgICAgICAgICAgICAuZ2V0U2NvcGVJbnN0YW5jZShjdXJTdGF0dXMuc2MsIGN1clN0YXR1cy5kZWx0YSk7XG4gICAgICAgICAgICAvLyBnZXQgdGhlIEFWYWwgZm9yIGV4Y2VwdGlvbiBwYXJhbWV0ZXJcbiAgICAgICAgICAgIGNvbnN0IGV4Y0FWYWwgPSBjYXRjaEJsb2NrU0MuZ2V0QVZhbE9mKG5vZGUuaGFuZGxlci5wYXJhbS5uYW1lKTtcblxuICAgICAgICAgICAgLy8gZm9yIHRyeSBibG9ja1xuICAgICAgICAgICAgY29uc3QgdHJ5U3RhdHVzID0gY2hhbmdlZFN0YXR1cyhjdXJTdGF0dXMsICdleGMnLCBleGNBVmFsKTtcbiAgICAgICAgICAgIGMobm9kZS5ibG9jaywgdHJ5U3RhdHVzLCB1bmRlZmluZWQpO1xuXG4gICAgICAgICAgICAvLyBmb3IgY2F0Y2ggYmxvY2tcbiAgICAgICAgICAgIGNvbnN0IGNhdGNoU3RhdHVzID0gY2hhbmdlZFN0YXR1cyhjdXJTdGF0dXMsICdzYycsIGNhdGNoQmxvY2tTQyk7XG4gICAgICAgICAgICBjKG5vZGUuaGFuZGxlci5ib2R5LCBjYXRjaFN0YXR1cywgdW5kZWZpbmVkKTtcblxuICAgICAgICAgICAgLy8gZm9yIGZpbmFsbHkgYmxvY2tcbiAgICAgICAgICAgIGlmIChub2RlLmZpbmFsaXplciAhPT0gbnVsbClcbiAgICAgICAgICAgICAgICBjKG5vZGUuZmluYWxpemVyLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgVGhyb3dTdGF0ZW1lbnQ6IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IHRociA9IGMobm9kZS5hcmd1bWVudCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7RlJPTTogdGhyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgVE86IGN1clN0YXR1cy5leGN9KTtcbiAgICAgICAgICAgIHRoci5wcm9wYWdhdGUoY3VyU3RhdHVzLmV4Yyk7XG4gICAgICAgIH0sXG5cbiAgICAgICAgQ2FsbEV4cHJlc3Npb246IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc0FWYWwgPSDEiC5nZXQobm9kZSwgY3VyU3RhdHVzLmRlbHRhKTtcbiAgICAgICAgICAgIGNvbnN0IGFyZ0FWYWxzID0gW107XG5cbiAgICAgICAgICAgIC8vIGdldCBBVmFscyBmb3IgZWFjaCBhcmd1bWVudHNcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgbm9kZS5hcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgICAgICBhcmdBVmFscy5wdXNoKFxuICAgICAgICAgICAgICAgICAgICBjKG5vZGUuYXJndW1lbnRzW2ldLCBjdXJTdGF0dXMsIHVuZGVmaW5lZCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gYXBwZW5kIGN1cnJlbnQgY2FsbCBzaXRlIHRvIHRoZSBjb250ZXh0XG4gICAgICAgICAgICBjb25zdCBuZXdEZWx0YSA9IGN1clN0YXR1cy5kZWx0YS5hcHBlbmRPbmUobm9kZVsnQGxhYmVsJ10pO1xuXG4gICAgICAgICAgICBpZiAobm9kZS5jYWxsZWUudHlwZSA9PT0gJ01lbWJlckV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgLy8gbWV0aG9kIGNhbGxcbiAgICAgICAgICAgICAgICAvLyB2YXIgcmVjdiA9IGMobm9kZS5jYWxsZWUub2JqZWN0LCBjdXJTdGF0dXMsIHVuZGVmaW5lZCk7XG4gICAgICAgICAgICAgICAgLy8gdmFyIG1ldGhvZE5hbWUgPSBpbW1lZFByb3Aobm9kZS5jYWxsZWUpO1xuICAgICAgICAgICAgICAgIC8vIGNvbnN0cmFpbnRzLnB1c2goe1xuICAgICAgICAgICAgICAgIC8vICAgUkVDVjogcmVjdixcbiAgICAgICAgICAgICAgICAvLyAgIFBST1BOQU1FOiBtZXRob2ROYW1lLFxuICAgICAgICAgICAgICAgIC8vICAgUEFSQU1TOiBhcmdBVmFscyxcbiAgICAgICAgICAgICAgICAvLyAgIFJFVDogcmVzQVZhbCxcbiAgICAgICAgICAgICAgICAvLyAgIEVYQzogY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAvLyAgIERFTFRBOiBuZXdEZWx0YVxuICAgICAgICAgICAgICAgIC8vIH0pO1xuICAgICAgICAgICAgICAgIGNvbnN0IFtyZWN2QVZhbCwgcmV0QVZhbF0gPSByZWFkTWVtYmVyKG5vZGUuY2FsbGVlLCBjdXJTdGF0dXMsIGMpO1xuICAgICAgICAgICAgICAgIHJldEFWYWwucHJvcGFnYXRlKFxuICAgICAgICAgICAgICAgICAgICBuZXcgY3N0ci5Jc0NhbGxlZShcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY3ZBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgYXJnQVZhbHMsXG4gICAgICAgICAgICAgICAgICAgICAgICByZXNBVmFsLFxuICAgICAgICAgICAgICAgICAgICAgICAgY3VyU3RhdHVzLmV4YyxcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RlbHRhKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIG5vcm1hbCBmdW5jdGlvbiBjYWxsXG4gICAgICAgICAgICAgICAgY29uc3QgY2FsbGVlQVZhbCA9IGMobm9kZS5jYWxsZWUsIGN1clN0YXR1cywgdW5kZWZpbmVkKTtcbiAgICAgICAgICAgICAgICAvLyBjYWxsZWXsnZggcmV0dXJu7J2EIGNhbGwgZXhwcmVzc2lvbuycvOuhnFxuICAgICAgICAgICAgICAgIC8vIGNhbGxlZeydmCBleGNlcHRpb27snYQg7Zi47LacIOy4oeydmCBleGNlcHRpb27sl5Ag7KCE64us7ZW07JW8XG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7XG4gICAgICAgICAgICAgICAgICAgIENBTExFRTogY2FsbGVlQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgU0VMRjogcnRDWC5nbG9iYWxPYmplY3QsXG4gICAgICAgICAgICAgICAgICAgIFBBUkFNUzogYXJnQVZhbHMsXG4gICAgICAgICAgICAgICAgICAgIFJFVDogcmVzQVZhbCxcbiAgICAgICAgICAgICAgICAgICAgRVhDOiBjdXJTdGF0dXMuZXhjLFxuICAgICAgICAgICAgICAgICAgICBERUxUQTogbmV3RGVsdGFcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBjYWxsZWVBVmFsLnByb3BhZ2F0ZShcbiAgICAgICAgICAgICAgICAgICAgbmV3IGNzdHIuSXNDYWxsZWUoXG4gICAgICAgICAgICAgICAgICAgICAgICBuZXcgdHlwZXMuQVZhbChydENYLmdsb2JhbE9iamVjdCksXG4gICAgICAgICAgICAgICAgICAgICAgICBhcmdBVmFscyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlc0FWYWwsXG4gICAgICAgICAgICAgICAgICAgICAgICBjdXJTdGF0dXMuZXhjLFxuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGVsdGEpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXNBVmFsO1xuICAgICAgICB9LFxuXG4gICAgICAgIE1lbWJlckV4cHJlc3Npb246IGZ1bmN0aW9uIChub2RlLCBjdXJTdGF0dXMsIGMpIHtcbiAgICAgICAgICAgIGNvbnN0IFssIHJldEFWYWxdID0gcmVhZE1lbWJlcihub2RlLCBjdXJTdGF0dXMsIGMpO1xuICAgICAgICAgICAgcmV0dXJuIHJldEFWYWw7XG4gICAgICAgIH0sXG5cbiAgICAgICAgUmV0dXJuU3RhdGVtZW50OiBmdW5jdGlvbiAobm9kZSwgY3VyU3RhdHVzLCBjKSB7XG4gICAgICAgICAgICBpZiAoIW5vZGUuYXJndW1lbnQpIHJldHVybjtcbiAgICAgICAgICAgIGNvbnN0IHJldCA9IGMobm9kZS5hcmd1bWVudCwgY3VyU3RhdHVzLCB1bmRlZmluZWQpO1xuICAgICAgICAgICAgY29uc3RyYWludHMucHVzaCh7RlJPTTogcmV0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgVE86IGN1clN0YXR1cy5yZXR9KTtcbiAgICAgICAgICAgIHJldC5wcm9wYWdhdGUoY3VyU3RhdHVzLnJldCk7XG4gICAgICAgIH1cbiAgICB9KTtcblxuICAgIHJlY3Vyc2l2ZVdpdGhSZXR1cm4oYXN0LCBpbml0U3RhdHVzLCBjb25zdHJhaW50R2VuZXJhdG9yKTtcblxuICAgIC8vIFdlIGFjdHVhbGx5IGFkZGVkIGNvbnN0cmFpbnRzXG4gICAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHJlY3Vyc2l2ZVdpdGhSZXR1cm4obm9kZSwgc3RhdGUsIHZpc2l0b3IpIHtcbiAgICBmdW5jdGlvbiBjKG5vZGUsIHN0LCBvdmVycmlkZSkge1xuICAgICAgICByZXR1cm4gdmlzaXRvcltvdmVycmlkZSB8fCBub2RlLnR5cGVdKG5vZGUsIHN0LCBjKTtcbiAgICB9XG4gICAgcmV0dXJuIGMobm9kZSwgc3RhdGUpO1xufVxuXG5leHBvcnRzLmNvbnN0cmFpbnRzID0gY29uc3RyYWludHM7XG5leHBvcnRzLmFkZENvbnN0cmFpbnRzID0gYWRkQ29uc3RyYWludHM7XG5leHBvcnRzLmNsZWFyQ29uc3RyYWludHMgPSBjbGVhckNvbnN0cmFpbnRzO1xuIiwiJ3VzZSBzdHJpY3QnO1xuXG5jb25zdCB0eXBlcyA9IHJlcXVpcmUoJy4uL2RvbWFpbnMvdHlwZXMnKTtcbmNvbnN0IHN0YXR1cyA9IHJlcXVpcmUoJy4uL2RvbWFpbnMvc3RhdHVzJyk7XG5jb25zdCBjR2VuID0gcmVxdWlyZSgnLi9jR2VuJyk7XG5cbmZ1bmN0aW9uIENTVFIoKSB7fVxuQ1NUUi5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuQ1NUUi5wcm90b3R5cGUuZXF1YWxzID0gZnVuY3Rpb24gKG90aGVyKSB7XG4gICAgcmV0dXJuIHRoaXMgPT09IG90aGVyO1xufTtcblxuZnVuY3Rpb24gUmVhZFByb3AocHJvcCwgdG8pIHtcbiAgICB0aGlzLnByb3AgPSBwcm9wO1xuICAgIHRoaXMudG8gPSB0bztcbn1cblJlYWRQcm9wLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoQ1NUUi5wcm90b3R5cGUpO1xuUmVhZFByb3AucHJvdG90eXBlLmFkZFR5cGUgPSBmdW5jdGlvbiAob2JqKSB7XG4gICAgaWYgKCEob2JqIGluc3RhbmNlb2YgKHR5cGVzLk9ialR5cGUpKSkgcmV0dXJuO1xuICAgIC8vIHdoZW4gb2JqIGlzIE9ialR5cGUsXG4gICAgY29uc3Qgb3duUHJvcCA9IG9iai5nZXRQcm9wKHRoaXMucHJvcCwgdHJ1ZSk7XG4gICAgaWYgKG93blByb3ApIHtcbiAgICAgICAgLy8gd2hlbiB0aGUgb2JqZWN0IGhhcyB0aGUgcHJvcCxcbiAgICAgICAgb3duUHJvcC5wcm9wYWdhdGUodGhpcy50byk7XG4gICAgfSBlbHNlIGlmIChvYmouZ2V0UHJvcCgnX19wcm90b19fJywgdHJ1ZSkpIHtcbiAgICAgICAgLy8gdXNlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBvYmouZ2V0UHJvcCgnX19wcm90b19fJylcbiAgICAgICAgICAucHJvcGFnYXRlKG5ldyBSZWFkUHJvcCh0aGlzLnByb3AsIHRoaXMudG8pKTtcbiAgICB9XG59O1xuUmVhZFByb3AucHJvdG90eXBlLmVxdWFscyA9IGZ1bmN0aW9uIChvdGhlcikge1xuICAgIGlmICghKG90aGVyIGluc3RhbmNlb2YgUmVhZFByb3ApKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMucHJvcCA9PT0gb3RoZXIucHJvcFxuICAgICAgICAmJiB0aGlzLnRvLmVxdWFscyhvdGhlci50byk7XG59O1xuXG5mdW5jdGlvbiBXcml0ZVByb3AocHJvcCwgZnJvbSkge1xuICAgIHRoaXMucHJvcCA9IHByb3A7XG4gICAgdGhpcy5mcm9tID0gZnJvbTtcbn1cbldyaXRlUHJvcC5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKENTVFIucHJvdG90eXBlKTtcbldyaXRlUHJvcC5wcm90b3R5cGUuYWRkVHlwZSA9IGZ1bmN0aW9uIChvYmopIHtcbiAgICBpZiAoIShvYmogaW5zdGFuY2VvZiAodHlwZXMuT2JqVHlwZSkpKSByZXR1cm47XG4gICAgY29uc3Qgb3duUHJvcCA9IG9iai5nZXRQcm9wKHRoaXMucHJvcCk7XG4gICAgdGhpcy5mcm9tLnByb3BhZ2F0ZShvd25Qcm9wKTtcbn07XG5cbmZ1bmN0aW9uIElzQWRkZWQob3RoZXIsIHRhcmdldCkge1xuICAgIHRoaXMub3RoZXIgPSBvdGhlcjtcbiAgICB0aGlzLnRhcmdldCA9IHRhcmdldDtcbn1cbklzQWRkZWQucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShDU1RSLnByb3RvdHlwZSk7XG5Jc0FkZGVkLnByb3RvdHlwZS5hZGRUeXBlID0gZnVuY3Rpb24gKHR5cGUpIHtcbiAgICBpZiAoKHR5cGUgPT09IHR5cGVzLlByaW1OdW1iZXIgXG4gICAgICAgICB8fCB0eXBlID09PSB0eXBlcy5QcmltQm9vbGVhbilcbiAgICAgJiYgKHRoaXMub3RoZXIuaGFzVHlwZSh0eXBlcy5QcmltTnVtYmVyKSBcbiAgICAgICAgIHx8IHRoaXMub3RoZXIuaGFzVHlwZSh0eXBlcy5QcmltQm9vbGVhbikpKSB7XG4gICAgICAgIHRoaXMudGFyZ2V0LmFkZFR5cGUodHlwZXMuUHJpbU51bWJlcik7XG4gICAgfVxuICAgIGlmICh0eXBlID09PSB0eXBlcy5QcmltU3RyaW5nXG4gICAgICYmICF0aGlzLm90aGVyLmlzRW1wdHkoKSkge1xuICAgICAgICAgdGhpcy50YXJnZXQuYWRkVHlwZSh0eXBlcy5QcmltU3RyaW5nKTtcbiAgICB9XG59O1xuXG5mdW5jdGlvbiBJc0NhbGxlZShzZWxmLCBhcmdzLCByZXQsIGV4YywgZGVsdGEpIHtcbiAgICB0aGlzLnNlbGYgPSBzZWxmO1xuICAgIHRoaXMuYXJncyA9IGFyZ3M7XG4gICAgdGhpcy5yZXQgPSByZXQ7XG4gICAgdGhpcy5leGMgPSBleGM7XG4gICAgdGhpcy5kZWx0YSA9IGRlbHRhO1xufVxuSXNDYWxsZWUucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShDU1RSLnByb3RvdHlwZSk7XG5Jc0NhbGxlZS5wcm90b3R5cGUuYWRkVHlwZSA9IGZ1bmN0aW9uIChmKSB7XG4gICAgaWYgKCEoZiBpbnN0YW5jZW9mICh0eXBlcy5GblR5cGUpKSkgcmV0dXJuO1xuICAgIGNvbnN0IGZ1bkVudiA9IGYuZ2V0RnVuRW52KHRoaXMuZGVsdGEpO1xuICAgIGNvbnN0IG5ld1NDID0gZi5vcmlnaW5Ob2RlLmJvZHlbJ0BibG9jayddLmdldFNjb3BlSW5zdGFuY2UoZi5zYywgdGhpcy5kZWx0YSk7XG4gICAgY29uc3QgZnVuU3RhdHVzXG4gICAgICAgID0gbmV3IHN0YXR1cy5TdGF0dXMoZnVuRW52WzBdLCBmdW5FbnZbMV0sIGZ1bkVudlsyXSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5kZWx0YSwgbmV3U0MpO1xuICAgIC8vIHBhc3MgdGhpcyBvYmplY3RcbiAgICB0aGlzLnNlbGYucHJvcGFnYXRlKGZ1bkVudlswXSk7XG5cbiAgICBjb25zdCBtaW5MZW4gPSBNYXRoLm1pbih0aGlzLmFyZ3MubGVuZ3RoLCBmLnBhcmFtTmFtZXMubGVuZ3RoKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1pbkxlbjsgaSsrKSB7XG4gICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUobmV3U0MuZ2V0QVZhbE9mKGYucGFyYW1OYW1lc1tpXSkpO1xuICAgIH1cblxuICAgIC8vIGZvciBhcmd1bWVudHMgb2JqZWN0XG4gICAgaWYgKGYub3JpZ2luTm9kZS5ib2R5WydAYmxvY2snXS51c2VBcmd1bWVudHNPYmplY3QpIHtcbiAgICAgICAgY29uc3QgYXJnT2JqID0gZi5nZXRBcmd1bWVudHNPYmplY3QodGhpcy5kZWx0YSk7XG4gICAgICAgIG5ld1NDLmdldEFWYWxPZignYXJndW1lbnRzJykuYWRkVHlwZShhcmdPYmopO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdGhpcy5hcmdzW2ldLnByb3BhZ2F0ZShhcmdPYmouZ2V0UHJvcChpICsgJycpKTtcbiAgICAgICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUoYXJnT2JqLmdldFByb3AobnVsbCkpO1xuICAgICAgICB9XG4gICAgICAgIGFyZ09iai5nZXRQcm9wKCdjYWxsZWUnKS5hZGRUeXBlKGYpO1xuICAgICAgICBhcmdPYmouZ2V0UHJvcCgnbGVuZ3RoJykuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICB9XG5cbiAgICAvLyBjb25zdHJhaW50IGdlbmVyYXRpb24gZm9yIHRoZSBmdW5jdGlvbiBib2R5XG4gICAgY0dlbi5hZGRDb25zdHJhaW50cyhmLm9yaWdpbk5vZGUuYm9keSwgZnVuU3RhdHVzKTtcblxuICAgIC8vIGdldCByZXR1cm4gXG4gICAgZnVuRW52WzFdLnByb3BhZ2F0ZSh0aGlzLnJldCk7XG4gICAgLy8gZ2V0IGV4Y2VwdGlvblxuICAgIGZ1bkVudlsyXS5wcm9wYWdhdGUodGhpcy5leGMpO1xufTtcblxuZnVuY3Rpb24gSXNDdG9yKGFyZ3MsIHJldCwgZXhjLCBkZWx0YSkge1xuICAgIHRoaXMuYXJncyA9IGFyZ3M7XG4gICAgdGhpcy5yZXQgPSByZXQ7XG4gICAgdGhpcy5leGMgPSBleGM7XG4gICAgdGhpcy5kZWx0YSA9IGRlbHRhO1xufVxuSXNDdG9yLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoQ1NUUi5wcm90b3R5cGUpO1xuSXNDdG9yLnByb3RvdHlwZS5hZGRUeXBlID0gZnVuY3Rpb24gKGYpIHtcbiAgICBpZiAoIShmIGluc3RhbmNlb2YgKHR5cGVzLkZuVHlwZSkpKSByZXR1cm47XG4gICAgY29uc3QgZnVuRW52ID0gZi5nZXRGdW5FbnYodGhpcy5kZWx0YSk7XG4gICAgY29uc3QgbmV3U0MgPSBmLm9yaWdpbk5vZGUuYm9keVsnQGJsb2NrJ10uZ2V0U2NvcGVJbnN0YW5jZShmLnNjLCB0aGlzLmRlbHRhKTtcbiAgICBjb25zdCBmdW5TdGF0dXNcbiAgICAgICAgPSBuZXcgc3RhdHVzLlN0YXR1cyhmdW5FbnZbMF0sIG5ldyBJZk9ialR5cGUoZnVuRW52WzFdKSwgZnVuRW52WzJdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuZGVsdGEsIG5ld1NDKTtcbiAgICAvLyBwYXNzIHRoaXMgb2JqZWN0XG4gICAgY29uc3QgbmV3T2JqID0gZi5nZXRJbnN0YW5jZSgpO1xuICAgIGZ1bkVudlswXS5hZGRUeXBlKG5ld09iaik7XG5cbiAgICBjb25zdCBtaW5MZW4gPSBNYXRoLm1pbih0aGlzLmFyZ3MubGVuZ3RoLCBmLnBhcmFtTmFtZXMubGVuZ3RoKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1pbkxlbjsgaSsrKSB7XG4gICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUobmV3U0MuZ2V0QVZhbE9mKGYucGFyYW1OYW1lc1tpXSkpO1xuICAgIH1cblxuICAgIC8vIGZvciBhcmd1bWVudHMgb2JqZWN0XG4gICAgaWYgKGYub3JpZ2luTm9kZS5ib2R5WydAYmxvY2snXS51c2VBcmd1bWVudHNPYmplY3QpIHtcbiAgICAgICAgY29uc3QgYXJnT2JqID0gZi5nZXRBcmd1bWVudHNPYmplY3QodGhpcy5kZWx0YSk7XG4gICAgICAgIG5ld1NDLmdldEFWYWxPZignYXJndW1lbnRzJykuYWRkVHlwZShhcmdPYmopO1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdGhpcy5hcmdzW2ldLnByb3BhZ2F0ZShhcmdPYmouZ2V0UHJvcChpICsgJycpKTtcbiAgICAgICAgICAgIHRoaXMuYXJnc1tpXS5wcm9wYWdhdGUoYXJnT2JqLmdldFByb3AobnVsbCkpO1xuICAgICAgICB9XG4gICAgICAgIGFyZ09iai5nZXRQcm9wKCdjYWxsZWUnKS5hZGRUeXBlKGYpO1xuICAgICAgICBhcmdPYmouZ2V0UHJvcCgnbGVuZ3RoJykuYWRkVHlwZSh0eXBlcy5QcmltTnVtYmVyKTtcbiAgICB9XG5cbiAgICAvLyBjb25zdHJhaW50IGdlbmVyYXRpb24gZm9yIHRoZSBmdW5jdGlvbiBib2R5XG4gICAgY0dlbi5hZGRDb25zdHJhaW50cyhmLm9yaWdpbk5vZGUuYm9keSwgZnVuU3RhdHVzKTtcblxuICAgIC8vIGJ5IGV4cGxpY2l0IHJldHVybiwgb25seSBPYmpUeXBlIGFyZSBwcm9wYWdhdGVkXG4gICAgZnVuRW52WzFdLnByb3BhZ2F0ZSh0aGlzLnJldCk7XG4gICAgLy8gcmV0dXJuIG5ldyBvYmplY3RcbiAgICB0aGlzLnJldC5hZGRUeXBlKG5ld09iaik7XG4gICAgLy8gZ2V0IGV4Y2VwdGlvblxuICAgIGZ1bkVudlsyXS5wcm9wYWdhdGUodGhpcy5leGMpO1xufTtcblxuLy8gaWdub3JlIG5vbiBvYmplY3QgdHlwZXNcbmZ1bmN0aW9uIElmT2JqVHlwZShhdmFsKSB7XG4gICAgdGhpcy5hdmFsID0gYXZhbDtcbn1cbklmT2JqVHlwZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKENTVFIucHJvdG90eXBlKTtcbklmT2JqVHlwZS5wcm90b3R5cGUuYWRkVHlwZSA9IGZ1bmN0aW9uICh0eXBlKSB7XG4gICAgaWYgKCEodHlwZSBpbnN0YW5jZW9mIHR5cGVzLk9ialR5cGUpKSByZXR1cm47XG4gICAgdGhpcy5hdmFsLmFkZFR5cGUodHlwZSk7XG59O1xuXG5leHBvcnRzLlJlYWRQcm9wID0gUmVhZFByb3A7XG5leHBvcnRzLldyaXRlUHJvcCA9IFdyaXRlUHJvcDtcbmV4cG9ydHMuSXNBZGRlZCA9IElzQWRkZWQ7XG5leHBvcnRzLklzQ2FsbGVlID0gSXNDYWxsZWU7XG5leHBvcnRzLklzQ3RvciA9IElzQ3RvcjtcbiIsIi8vIENvbnRleHQgZm9yIGstQ0ZBIGFuYWx5c2lzXG4vL1xuLy8gQXNzdW1lIGEgY29udGV4dCBpcyBhbiBhcnJheSBvZiBudW1iZXJzLlxuLy8gQSBudW1iZXIgaW4gc3VjaCBsaXN0IGRlbm90ZXMgYSBjYWxsIHNpdGUsIHRoYXQgaXMgQGxhYmVsIG9mIGEgQ2FsbEV4cHJlc3Npb24uXG4vLyBXZSBrZWVwIHRoZSBtb3N0IHJlY2VudCAnaycgY2FsbHNpdGVzLlxuLy8gRXF1YWxpdHkgb24gY29udGV4dHMgc2hvdWxkIGxvb2sgaW50byB0aGUgbnVtYmVycy5cblxudmFyIGNhbGxTaXRlQ29udGV4dFBhcmFtZXRlciA9IHtcbiAgICAvLyBtYXhpbXVtIGxlbmd0aCBvZiBjb250ZXh0XG4gICAgbWF4RGVwdGhLOiAwLFxuICAgIC8vIGZ1bmN0aW9uIGxpc3QgZm9yIHNlbnNpdGl2ZSBhbmFseXNpc1xuICAgIHNlbnNGdW5jczoge31cbn07XG5cbmZ1bmN0aW9uIENhbGxTaXRlQ29udGV4dChjc0xpc3QpIHtcbiAgICBpZiAoY3NMaXN0KSB0aGlzLmNzTGlzdCA9IGNzTGlzdDtcbiAgICBlbHNlIHRoaXMuY3NMaXN0ID0gW107XG59XG5cbkNhbGxTaXRlQ29udGV4dC5wcm90b3R5cGUuZXF1YWxzID0gZnVuY3Rpb24gKG90aGVyKSB7XG4gICAgaWYgKHRoaXMuY3NMaXN0Lmxlbmd0aCAhPSBvdGhlci5jc0xpc3QubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmNzTGlzdC5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAodGhpcy5jc0xpc3RbaV0gIT09IG90aGVyLmNzTGlzdFtpXSkgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbn07XG5cbkNhbGxTaXRlQ29udGV4dC5wcm90b3R5cGUuYXBwZW5kT25lID0gZnVuY3Rpb24gKGNhbGxTaXRlKSB7XG4gICAgLy8gdXNlIGNvbmNhdCB0byBjcmVhdGUgYSBuZXcgYXJyYXlcbiAgICAvLyBvbGRlc3Qgb25lIGNvbWVzIGZpcnN0XG4gICAgdmFyIGFwcGVuZGVkID0gdGhpcy5jc0xpc3QuY29uY2F0KGNhbGxTaXRlKTtcbiAgICBpZiAoYXBwZW5kZWQubGVuZ3RoID4gY2FsbFNpdGVDb250ZXh0UGFyYW1ldGVyLm1heERlcHRoSykge1xuICAgICAgICBhcHBlbmRlZC5zaGlmdCgpO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IENhbGxTaXRlQ29udGV4dChhcHBlbmRlZCk7XG59O1xuXG5DYWxsU2l0ZUNvbnRleHQucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmNzTGlzdC50b1N0cmluZygpO1xufTtcblxuZXhwb3J0cy5jYWxsU2l0ZUNvbnRleHRQYXJhbWV0ZXIgPSBjYWxsU2l0ZUNvbnRleHRQYXJhbWV0ZXI7XG5leHBvcnRzLkNhbGxTaXRlQ29udGV4dCA9IENhbGxTaXRlQ29udGV4dDsiLCIvLyBTdGF0dXM6XG4vLyB7IHNlbGYgIDogQVZhbCxcbi8vICAgcmV0ICAgOiBBVmFsLFxuLy8gICBleGMgICA6IEFWYWwsXG4vLyAgIGRlbHRhIDogQ29udGV4dCxcbi8vICAgc2MgICAgOiBTY29wZUNoYWluIH1cblxuZnVuY3Rpb24gU3RhdHVzKHNlbGYsIHJldCwgZXhjLCBkZWx0YSwgc2MpIHtcbiAgICB0aGlzLnNlbGYgPSBzZWxmO1xuICAgIHRoaXMucmV0ID0gcmV0O1xuICAgIHRoaXMuZXhjID0gZXhjO1xuICAgIHRoaXMuZGVsdGEgPSBkZWx0YTtcbiAgICB0aGlzLnNjID0gc2M7XG59XG5cblN0YXR1cy5wcm90b3R5cGUuZXF1YWxzID0gZnVuY3Rpb24gKG90aGVyKSB7XG4gICAgcmV0dXJuIHRoaXMuc2VsZiA9PT0gb3RoZXIuc2VsZiAmJlxuICAgICAgICB0aGlzLnJldCA9PT0gb3RoZXIucmV0ICYmXG4gICAgICAgIHRoaXMuZXhjID09PSBvdGhlci5leGMgJiZcbiAgICAgICAgdGhpcy5kZWx0YS5lcXVhbHMob3RoZXIuZGVsdGEpICYmXG4gICAgICAgIHRoaXMuc2MgPT09IG90aGVyLnNjO1xufTtcblxuZXhwb3J0cy5TdGF0dXMgPSBTdGF0dXM7IiwiJ3VzZSBzdHJpY3QnO1xuXG4vLyBmb3IgREVCVUdcbnZhciBjb3VudCA9IDA7XG4vKipcbiAqIHRoZSBhYnN0cmFjdCB2YWx1ZSBmb3IgYSBjb25jcmV0ZSB2YWx1ZVxuICogd2hpY2ggaXMgYSBzZXQgb2YgdHlwZXMuXG4gKiBAY29uc3RydWN0b3JcbiAqIEBwYXJhbSB7VHlwZX0gdHlwZSAtIGdpdmUgYSB0eXBlIHRvIG1ha2UgQVZhbCB3aXRoIGEgc2luZ2xlIHR5cGVcbiAqL1xuZnVuY3Rpb24gQVZhbCh0eXBlKSB7XG4gICAgLy8gdHlwZTogY29udGFpbmVkIHR5cGVzXG4gICAgLy8gV2UgYXNzdW1lIHR5cGVzIGFyZSBkaXN0aW5ndWlzaGFibGUgYnkgJz09PSdcbiAgICBpZiAodHlwZSkgdGhpcy50eXBlcyA9IG5ldyBTZXQoW3R5cGVdKTtcbiAgICBlbHNlIHRoaXMudHlwZXMgPSBuZXcgU2V0KCk7XG4gICAgLy8gZm9yd2FyZHM6IHByb3BhZ2F0aW9uIHRhcmdldHNcbiAgICAvLyBXZSBhc3N1bWUgdGFyZ2V0cyBhcmUgZGlzdGluZ3Vpc2hhYmxlIGJ5ICdlcXVhbHMnIG1ldGhvZFxuICAgIHRoaXMuZm9yd2FyZHMgPSBuZXcgU2V0KCk7XG4gICAgLy8gZm9yIERFQlVHXG4gICAgdGhpcy5faWQgPSBjb3VudCsrO1xufVxuLyoqIENoZWNrIHdoZXRoZXIgaXQgaGFzIGFueSB0eXBlXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn1cbiAqL1xuQVZhbC5wcm90b3R5cGUuaXNFbXB0eSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy50eXBlcy5zaXplID09PSAwO1xufTtcblxuLyoqXG4gKiBAcmV0dXJucyB7W1R5cGVdfVxuICovXG5BVmFsLnByb3RvdHlwZS5nZXRUeXBlcyA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy50eXBlcztcbn07XG5cbi8qKlxuICogQHJldHVybnMge2Jvb2xlYW59XG4gKi9cbkFWYWwucHJvdG90eXBlLmhhc1R5cGUgPSBmdW5jdGlvbiAodHlwZSkge1xuICAgIHJldHVybiB0aGlzLnR5cGVzLmhhcyh0eXBlKTtcbn07XG5cbi8qKlxuICogQWRkIGEgdHlwZS5cbiAqIEBwYXJhbSB7VHlwZX0gdHlwZVxuICovXG5BVmFsLnByb3RvdHlwZS5hZGRUeXBlID0gZnVuY3Rpb24gKHR5cGUpIHtcbiAgICBpZiAodGhpcy50eXBlcy5oYXModHlwZSkpIHJldHVybjtcbiAgICAvLyBnaXZlbiB0eXBlIGlzIG5ld1xuICAgIHRoaXMudHlwZXMuYWRkKHR5cGUpO1xuICAgIC8vIHNlbmQgdG8gcHJvcGFnYXRpb24gdGFyZ2F0c1xuICAgIHRoaXMuZm9yd2FyZHMuZm9yRWFjaChmdW5jdGlvbiAoZndkKSB7XG4gICAgICAgIGZ3ZC5hZGRUeXBlKHR5cGUpO1xuICAgIH0pO1xufTtcbi8qKlxuICogQHBhcmFtIHtBVmFsfSB0YXJnZXRcbiAqL1xuQVZhbC5wcm90b3R5cGUucHJvcGFnYXRlID0gZnVuY3Rpb24gKHRhcmdldCkge1xuICAgIGlmICghdGhpcy5hZGRGb3J3YXJkKHRhcmdldCkpIHJldHVybjtcbiAgICAvLyB0YXJnZXQgaXMgbmV3bHkgYWRkZWRcbiAgICAvLyBzZW5kIHR5cGVzIHRvIHRoZSBuZXcgdGFyZ2V0XG4gICAgdGhpcy50eXBlcy5mb3JFYWNoKGZ1bmN0aW9uICh0eXBlKSB7XG4gICAgICAgIHRhcmdldC5hZGRUeXBlKHR5cGUpO1xuICAgIH0pO1xufTtcblxuQVZhbC5wcm90b3R5cGUuYWRkRm9yd2FyZCA9IGZ1bmN0aW9uIChmd2QpIHtcbiAgICBmb3IgKGxldCBvbGRGd2Qgb2YgdGhpcy5mb3J3YXJkcykge1xuICAgICAgICBpZiAoZndkLmVxdWFscyhvbGRGd2QpKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHRoaXMuZm9yd2FyZHMuYWRkKGZ3ZCk7XG4gICAgcmV0dXJuIHRydWU7XG59O1xuXG5BVmFsLnByb3RvdHlwZS5lcXVhbHMgPSBmdW5jdGlvbiAob3RoZXIpIHtcbiAgICAvLyBzaW1wbGUgcmVmZXJlbmNlIGNvbXBhcmlzb25cbiAgICByZXR1cm4gdGhpcyA9PT0gb3RoZXI7XG59O1xuXG4vKipcbiAqIFRPRE86IGNoZWNrIHdoZXRoZXIgd2UgcmVhbGx5IG5lZWQgdGhpcyBtZXRob2QuXG4gKiBAcGFyYW0ge3N0cmluZ30gcHJvcFxuICogQHJldHVybnMge0FWYWx9XG4gKi9cbkFWYWwucHJvdG90eXBlLmdldFByb3AgPSBmdW5jdGlvbiAocHJvcCkge1xuICAgIGlmIChwcm9wID09PSAn4pyWJykge1xuICAgICAgICAvLyDinJYgaXMgdGhlIGJvZ3VzIHByb3BlcnR5IG5hbWUgYWRkZWQgZm9yIGVycm9yIHJlY292ZXJ5LlxuICAgICAgICByZXR1cm4gQVZhbE51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLnByb3BzLmhhcyhwcm9wKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5wcm9wcy5nZXQocHJvcCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIEFWYWxOdWxsO1xuICAgIH1cbn07XG5cbi8qKlxuICogdGhlIHN1cGVyIGNsYXNzIG9mIGFsbCB0eXBlc1xuICogZWFjaCB0eXBlIHNob3VsZCBiZSBkaXN0aW5ndWlzaGFibGUgYnkgJz09PScgb3BlcmF0aW9uLlxuICogQGNvbnN0cnVjdG9yXG4gKi9cbmZ1bmN0aW9uIFR5cGUobmFtZSkge1xuICAgIHRoaXMubmFtZSA9IG5hbWU7XG59XG5UeXBlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5UeXBlLnByb3RvdHlwZS5nZXROYW1lID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLm5hbWU7XG59O1xuXG4vKipcbiAqIDEuIG9iamVjdCB0eXBlc1xuICogQHBhcmFtIHtBVmFsfSBwcm90byAtIEFWYWwgb2YgY29uc3RydWN0b3IncyBwcm90b3R5cGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIC0gZ3Vlc3NlZCBuYW1lXG4gKi9cbmZ1bmN0aW9uIE9ialR5cGUocHJvdG8sIG5hbWUpIHtcbiAgICB0aGlzLm5hbWUgPSBuYW1lO1xuICAgIHRoaXMucHJvcHMgPSBuZXcgTWFwKCk7XG5cbiAgICAvLyBzaGFyZSBwcm90byB3aXRoIF9fcHJvdG9fX1xuICAgIHRoaXMuc2V0UHJvcCgnX19wcm90b19fJywgcHJvdG8pO1xufVxuT2JqVHlwZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKFR5cGUucHJvdG90eXBlKTtcbi8qKlxuICogQHBhcmFtIHtzdHJpbmd8bnVsbH0gcHJvcCAtIG51bGwgZm9yIGNvbXB1dGVkIHByb3BzXG4gKiBAcGFyYW0ge2Jvb2xlYW59IHJlYWRPbmx5IC0gaWYgZmFsc2UsIGNyZWF0ZSBBVmFsIGZvciBwcm9wIGlmIG5lY2Vzc2FyeVxuICogQHJldHVybnMge0FWYWx9IEFWYWwgb2YgdGhlIHByb3BlcnR5XG4gKi9cbk9ialR5cGUucHJvdG90eXBlLmdldFByb3AgPSBmdW5jdGlvbiAocHJvcCwgcmVhZE9ubHkpIHtcbiAgICBpZiAocHJvcCA9PT0gJ+KclicpIHtcbiAgICAgICAgLy8g4pyWIGlzIHRoZSBib2d1cyBwcm9wZXJ0eSBuYW1lIGFkZGVkIGR1cmluZyBwYXJzaW5nIGVycm9yIHJlY292ZXJ5LlxuICAgICAgICByZXR1cm4gQVZhbE51bGw7XG4gICAgfVxuICAgIGlmICh0aGlzLnByb3BzLmhhcyhwcm9wKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5wcm9wcy5nZXQocHJvcCk7XG4gICAgfSBlbHNlIGlmIChyZWFkT25seSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbmV3UHJvcEFWYWwgPSBuZXcgQVZhbDtcbiAgICAgICAgdGhpcy5wcm9wcy5zZXQocHJvcCwgbmV3UHJvcEFWYWwpO1xuICAgICAgICByZXR1cm4gbmV3UHJvcEFWYWw7XG4gICAgfVxufTtcbi8qKlxuICogV2UgdXNlIHRoaXMgZnVuY3Rpb24gdG8gc2hhcmUgLnByb3RvdHlwZSB3aXRoIGluc3RhbmNlcyBfX3Byb3RvX19cbiAqIEl0IGlzIHBvc3NpYmxlIHRvIHVzZSB0aGlzIGZ1bmN0aW9uIHRvIG1lcmdlIEFWYWxzIHRvIG9wdGltaXplIHRoZSBhbmFseXplci5cbiAqIEBwYXJhbSB7c3RyaW5nfG51bGx9IHByb3AgLSBudWxsIGZvciBjb21wdXRlZCBwcm9wc1xuICogQHBhcmFtIHtBVmFsfSBhdmFsXG4gKi9cbk9ialR5cGUucHJvdG90eXBlLnNldFByb3AgPSBmdW5jdGlvbiAocHJvcCwgYXZhbCkge1xuICAgIGlmIChwcm9wID09PSAn4pyWJykge1xuICAgICAgICAvLyDinJYgaXMgdGhlIGJvZ3VzIHByb3BlcnR5IG5hbWUgYWRkZWQgZHVyaW5nIHBhcnNpbmcgZXJyb3IgcmVjb3ZlcnkuXG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5wcm9wcy5zZXQocHJvcCwgYXZhbCk7XG59O1xuLyoqXG4gKiBUT0RPOiBDaGVjayB0aGlzIGZ1bmN0aW9uJ3MgbmVjZXNzaXR5XG4gKiBAcGFyYW0ge3N0cmluZ30gcHJvcFxuICogQHJldHVybnMge2Jvb2xlYW59XG4gKi9cbk9ialR5cGUucHJvdG90eXBlLmhhc1Byb3AgPSBmdW5jdGlvbiAocHJvcCkge1xuICAgIGlmIChwcm9wID09PSAn4pyWJykgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiB0aGlzLnByb3BzLmhhcyhwcm9wKTtcbn07XG4vKipcbiAqIFRPRE86IENoZWNrIHRoaXMgZnVuY3Rpb24ncyBuZWNlc3NpdHlcbiAqIEBwYXJhbSB7VHlwZX0gdHlwZVxuICogQHBhcmFtIHtzdHJpbmd9IHByb3BcbiAqL1xuT2JqVHlwZS5wcm90b3R5cGUuYWRkVHlwZVRvUHJvcCA9IGZ1bmN0aW9uICh0eXBlLCBwcm9wKSB7XG4gICAgaWYgKHByb3AgPT09ICfinJYnKSByZXR1cm47XG4gICAgaWYgKCF0aGlzLnByb3BzLmhhcyhwcm9wKSkge1xuICAgICAgICB0aGlzLnByb3BzLnNldChwcm9wLCBuZXcgQVZhbCk7XG4gICAgfVxuICAgIGlmICh0aGlzLnByb3BzLmdldChwcm9wKS5oYXNUeXBlKHR5cGUpKSByZXR1cm47XG4gICAgdGhpcy5wcm9wcy5nZXQocHJvcCkuYWRkVHlwZSh0eXBlKTtcbn07XG4vKipcbiAqIFRPRE86IENoZWNrIHRoaXMgZnVuY3Rpb24ncyBuZWNlc3NpdHlcbiAqIEBwYXJhbSB7QVZhbH0gYXZhbFxuICogQHBhcmFtIHtzdHJpbmd9IHByb3BcbiAqL1xuT2JqVHlwZS5wcm90b3R5cGUuam9pbkFWYWxUb1Byb3AgPSBmdW5jdGlvbiAoYXZhbCwgcHJvcCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBhdmFsLmdldFR5cGVzKCkuZm9yRWFjaChmdW5jdGlvbiAodHlwZSkge1xuICAgICAgICBzZWxmLmFkZFR5cGVUb1Byb3AodHlwZSwgcHJvcCk7XG4gICAgfSk7XG59O1xuXG4vLyBtYWtlIGFuIE9iaiBmcm9tIHRoZSBnbG9iYWwgc2NvcGVcbmZ1bmN0aW9uIG1rT2JqRnJvbUdsb2JhbFNjb3BlKGdTY29wZSkge1xuICAgIHZhciBnT2JqID0gbmV3IE9ialR5cGUoQVZhbE51bGwsICcqZ2xvYmFsIHNjb3BlKicpO1xuICAgIGdPYmoucHJvcHMgPSBnU2NvcGUudmFyTWFwO1xuICAgIC8vIE92ZXJyaWRlIGdldFByb3AgbWV0aG9kIGZvciBnbG9iYWwgb2JqZWN0XG4gICAgLy8gV2UgaWdub3JlICdyZWFkT25seScgcGFyYW1ldGVyIHRvIGFsd2F5cyByZXR1cm4gaXRzIG93biBwcm9wIEFWYWwgXG4gICAgZ09iai5nZXRQcm9wID0gZnVuY3Rpb24gKHByb3ApIHtcbiAgICAgICAgcmV0dXJuIE9ialR5cGUucHJvdG90eXBlLmdldFByb3AuY2FsbCh0aGlzLCBwcm9wKTtcbiAgICB9O1xuICAgIHJldHVybiBnT2JqO1xufVxuXG4vKipcbiAqIDIuIHByaW1pdGl2ZSB0eXBlc1xuICogQGNvbnN0cnVjdG9yXG4gKiBAcGFyYW0ge3N0cmluZ30gbmFtZVxuICovXG5mdW5jdGlvbiBQcmltVHlwZShuYW1lKSB7XG4gICAgdGhpcy5uYW1lID0gbmFtZTtcbn1cblByaW1UeXBlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoVHlwZS5wcm90b3R5cGUpO1xuXG4vKipcbiAqIDMuIGZ1bmN0aW9uIHR5cGVzXG4gKiB0aGUgbmFtZSBpcyB1c2VkIGZvciB0aGUgdHlwZSBvZiB0aGUgaW5zdGFuY2VzIGZyb20gdGhlIGZ1bmN0aW9uXG4gKiBAY29uc3RydWN0b3JcbiAqIEBwYXJhbSB7QVZhbH0gZm5fcHJvdG8gLSBBVmFsIGZvciBjb25zdHJ1Y3RvcidzIC5wcm90b3R5cGVcbiAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIC0gZ3Vlc3NlZCBuYW1lXG4gKiBAcGFyYW0ge1tzdHJpbmddfSBhcmdOYW1lcyAtIGxpc3Qgb2YgcGFyYW1ldGVyIG5hbWVzXG4gKiBAcGFyYW0ge1Njb3BlfSBzYyAtIGZ1bmN0aW9ucyBzY29wZSBjaGFpbiwgb3IgY2xvc3VyZVxuICogQHBhcmFtIHtub2RlfSBvcmlnaW5Ob2RlIC0gQVNUIG5vZGUgZm9yIHRoZSBmdW5jdGlvblxuICogQHBhcmFtIHtUeXBlfSBhcmdQcm90byAtIHByb3RvdHlwZSBmb3IgYXJndW1lbnRzIG9iamVjdFxuICovXG5mdW5jdGlvbiBGblR5cGUoZm5fcHJvdG8sIG5hbWUsIGFyZ05hbWVzLCBzYywgb3JpZ2luTm9kZSwgYXJnUHJvdG8pIHtcbiAgICBPYmpUeXBlLmNhbGwodGhpcywgZm5fcHJvdG8sIG5hbWUpO1xuICAgIHRoaXMucGFyYW1OYW1lcyA9IGFyZ05hbWVzO1xuICAgIHRoaXMuc2MgPSBzYztcbiAgICB0aGlzLm9yaWdpbk5vZGUgPSBvcmlnaW5Ob2RlO1xuICAgIHRoaXMuYXJnUHJvdG8gPSBhcmdQcm90bztcbiAgICAvLyBmdW5FbnYgOiBDYWxsQ29udGV4dCAtPiBbc2VsZiwgcmV0LCBleGNdXG4gICAgdGhpcy5mdW5FbnYgPSBuZXcgTWFwO1xufVxuRm5UeXBlLnByb3RvdHlwZSA9IE9iamVjdC5jcmVhdGUoT2JqVHlwZS5wcm90b3R5cGUpO1xuXG4vKipcbiAqIGNvbnN0cnVjdCBTdGF0dXMgZm9yIGZ1bmN0aW9uXG4gKiBAcGFyYW0ge0NhbGxDb250ZXh0fSBkZWx0YSAtIGNhbGwgY29udGV4dFxuICogQHJldHVybnMge1tBVmFsLCBBVmFsLCBBVmFsXX0gLSBmb3Igc2VsZiwgcmV0dXJuIGFuZCBleGNlcHRpb24gQVZhbHNcbiAqL1xuRm5UeXBlLnByb3RvdHlwZS5nZXRGdW5FbnYgPSBmdW5jdGlvbiAoZGVsdGEpIHtcbiAgICBpZiAodGhpcy5mdW5FbnYuaGFzKGRlbHRhKSkge1xuICAgICAgICByZXR1cm4gdGhpcy5mdW5FbnYuZ2V0KGRlbHRhKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgdHJpcGxlID0gW25ldyBBVmFsLCBuZXcgQVZhbCwgbmV3IEFWYWxdO1xuICAgICAgICB0aGlzLmZ1bkVudi5zZXQoZGVsdGEsIHRyaXBsZSk7XG4gICAgICAgIHJldHVybiB0cmlwbGU7XG4gICAgfVxufTtcblxuRm5UeXBlLnByb3RvdHlwZS5nZXRBcmd1bWVudHNPYmplY3QgPSBmdW5jdGlvbiAoZGVsdGEpIHtcbiAgICB0aGlzLmFyZ09iak1hcCA9IHRoaXMuYXJnT2JqTWFwIHx8IG5ldyBNYXA7XG4gICAgaWYgKHRoaXMuYXJnT2JqTWFwLmhhcyhkZWx0YSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuYXJnT2JqTWFwLmdldChkZWx0YSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGFyZ09iaiA9IG5ldyBPYmpUeXBlKG5ldyBBVmFsKHRoaXMuYXJnUHJvdG8pLCAnKmFyZ3VtZW50cyBvYmplY3QqJyk7XG4gICAgICAgIHRoaXMuYXJnT2JqTWFwLnNldChkZWx0YSwgYXJnT2JqKTtcbiAgICAgICAgcmV0dXJuIGFyZ09iajtcbiAgICB9XG59O1xuXG4vKipcbiAqIGdldCBPYmplY3QgbWFkZSBieSB0aGUgZnVuY3Rpb25cbiAqIFRPRE86IHVzZSBhZGRpdGlvbmFsIGluZm9ybWF0aW9uIHRvIGNyZWF0ZSBtdWx0aXBsZSBpbnN0YW5jZXNcbiAqIEByZXR1cm5zIHtPYmpUeXBlfVxuICovXG5GblR5cGUucHJvdG90eXBlLmdldEluc3RhbmNlID0gZnVuY3Rpb24gKCkge1xuICAgIC8vIG9iakluc3RhbmNlIGlzIHRoZSBvYmplY3QgbWFkZSBieSB0aGUgZnVuY3Rpb2FublxuICAgIGlmICh0aGlzLm9iakluc3RhbmNlKSByZXR1cm4gdGhpcy5vYmpJbnN0YW5jZTtcbiAgICAvLyB3ZSB1bmlmeSBjb25zdHJ1Y3RvcidzIC5wcm90b3R5cGUgYW5kIGluc3RhbmNlJ3MgX19wcm90b19fXG4gICAgdGhpcy5vYmpJbnN0YW5jZSA9IG5ldyBPYmpUeXBlKHRoaXMuZ2V0UHJvcCgncHJvdG90eXBlJykpO1xuICAgIHJldHVybiB0aGlzLm9iakluc3RhbmNlO1xufTtcblxuLyoqIFxuICogNC4gYXJyYXkgdHlwZXNcbiAqIEBjb25zdHJ1Y3RvclxuICovXG5mdW5jdGlvbiBBcnJUeXBlKGFycl9wcm90bykge1xuICAgIE9ialR5cGUuY2FsbCh0aGlzLCBhcnJfcHJvdG8sICdBcnJheScpO1xufVxuQXJyVHlwZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKE9ialR5cGUucHJvdG90eXBlKTtcblxuLy8gTWFrZSBwcmltaXRpdmUgdHlwZXNcbnZhciBQcmltTnVtYmVyID0gbmV3IFByaW1UeXBlKCdudW1iZXInKTtcbnZhciBQcmltU3RyaW5nID0gbmV3IFByaW1UeXBlKCdzdHJpbmcnKTtcbnZhciBQcmltQm9vbGVhbiA9IG5ldyBQcmltVHlwZSgnYm9vbGVhbicpO1xuXG4vLyBBYnNOdWxsIHJlcHJlc2VudHMgYWxsIGVtcHR5IGFic3RyYWN0IHZhbHVlcy5cbnZhciBBVmFsTnVsbCA9IG5ldyBBVmFsKCk7XG4vLyBZb3Ugc2hvdWxkIG5vdCBhZGQgYW55IHByb3BlcnRpZXMgdG8gaXQuXG5BVmFsTnVsbC5wcm9wcyA9IG51bGw7XG4vLyBBZGRpbmcgdHlwZXMgYXJlIGlnbm9yZWQuXG5BVmFsTnVsbC5hZGRUeXBlID0gZnVuY3Rpb24gKCkge307XG5cbmNsYXNzIEFic0NhY2hlIHtcbiAgICBjb25zdHJ1Y3RvcigpIHtcbiAgICAgICAgdGhpcy5tYXAgPSBuZXcgTWFwKCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGlmIG9uZSBleGlzdHMsIGlmIG5vdCBjcmVhdGUgb25lXG4gICAgICogQHBhcmFtIGxvY1xuICAgICAqIEBwYXJhbSBjdHhcbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBnZXQobG9jLCBjdHgpIHtcbiAgICAgICAgaWYgKCF0aGlzLm1hcC5oYXMobG9jKSkge1xuICAgICAgICAgICAgLy8gY3JlYXRlIGlubmVyIG1hcFxuICAgICAgICAgICAgdGhpcy5tYXAuc2V0KGxvYywgbmV3IE1hcCgpKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBtYXBMb2MgPSB0aGlzLm1hcC5nZXQobG9jKTtcbiAgICAgICAgaWYgKCFtYXBMb2MuaGFzKGN0eCkpIHtcbiAgICAgICAgICAgIGNvbnN0IGF2ID0gbmV3IEFWYWwoKTtcbiAgICAgICAgICAgIG1hcExvYy5zZXQoY3R4LCBhdik7XG4gICAgICAgICAgICByZXR1cm4gYXY7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gbWFwTG9jLmdldChjdHgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVG8gdXNlIGF2IG1hZGUgYnkgb3RoZXJzIChlLmcuIHNjb3BlKVxuICAgICAqIEBwYXJhbSBsb2NcbiAgICAgKiBAcGFyYW0gY3R4XG4gICAgICogQHBhcmFtIGF2XG4gICAgICovXG4gICAgc2V0KGxvYywgY3R4LCBhdikge1xuICAgICAgICBpZiAoIXRoaXMubWFwLmhhcyhsb2MpKSB7XG4gICAgICAgICAgICAvLyBjcmVhdGUgaW5uZXIgbWFwXG4gICAgICAgICAgICB0aGlzLm1hcC5zZXQobG9jLCBuZXcgTWFwKCkpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMubWFwLmdldChsb2MpLnNldChjdHgsIGF2KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGl0IGhhcyBvbmUgZm9yIGxvYyBhbmQgY3R4XG4gICAgICogQHBhcmFtIGxvY1xuICAgICAqIEBwYXJhbSBjdHhcbiAgICAgKiBAcmV0dXJucyB7Ym9vbGVhbn1cbiAgICAgKi9cbiAgICBoYXMobG9jLCBjdHgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMubWFwLmhhcyhsb2MpICYmIHRoaXMubWFwLmdldChsb2MpLmhhcyhjdHgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhbGwgdGhlIHR5cGVzIG9mIHRoZSBsb2NcbiAgICAgKiBAcGFyYW0gbG9jXG4gICAgICogQHJldHVybnMgW1R5cGVdXG4gICAgICovXG4gICAgZ2V0VHlwZU9mTG9jKGxvYykge1xuICAgICAgICBpZiAoIXRoaXMubWFwLmhhcyhsb2MpKSB7XG4gICAgICAgICAgICAvLyBubyB0eXBlIGlzIGF2YWlsYWJsZVxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgdHBzID0gW107XG4gICAgICAgIGZvciAodmFyIGF2IG9mIHRoaXMubWFwLmdldChsb2MpLnZhbHVlcygpKSB7XG4gICAgICAgICAgICBmb3IgKHZhciB0cCBvZiBhdi5nZXRUeXBlcygpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRwcy5pbmRleE9mKHRwKSA9PT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgdHBzLnB1c2godHApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdHBzO1xuICAgIH1cbn1cblxuLy8gZXhwb3J0XG5leHBvcnRzLlR5cGUgPSBUeXBlO1xuZXhwb3J0cy5PYmpUeXBlID0gT2JqVHlwZTtcbmV4cG9ydHMuRm5UeXBlID0gRm5UeXBlO1xuZXhwb3J0cy5BcnJUeXBlID0gQXJyVHlwZTtcbmV4cG9ydHMuUHJpbU51bWJlciA9IFByaW1OdW1iZXI7XG5leHBvcnRzLlByaW1TdHJpbmcgPSBQcmltU3RyaW5nO1xuZXhwb3J0cy5QcmltQm9vbGVhbiA9IFByaW1Cb29sZWFuO1xuZXhwb3J0cy5ta09iakZyb21HbG9iYWxTY29wZSA9IG1rT2JqRnJvbUdsb2JhbFNjb3BlO1xuXG5leHBvcnRzLkFWYWwgPSBBVmFsO1xuZXhwb3J0cy5BVmFsTnVsbCA9IEFWYWxOdWxsO1xuXG5leHBvcnRzLkFic0NhY2hlID0gQWJzQ2FjaGU7XG4iLCJjb25zdCBteVdhbGtlciA9IHJlcXVpcmUoJy4vdXRpbC9teVdhbGtlcicpO1xuXG5mdW5jdGlvbiBnZXRUeXBlRGF0YShhc3QsIMSILCBzdGFydCwgZW5kKSB7XG4gICAgJ3VzZSBzdHJpY3QnO1xuICAgIGNvbnN0IG5vZGUgPSBteVdhbGtlci5maW5kU3Vycm91bmRpbmdOb2RlKGFzdCwgc3RhcnQsIGVuZCk7XG4gICAgY29uc3Qgbm9kZVR5cGVzID0gxIguZ2V0VHlwZU9mTG9jKG5vZGUpO1xuICAgIGxldCBoYXNUeXBlO1xuICAgIGxldCB0eXBlU3RyaW5nID0gJyc7XG4gICAgaWYgKCFub2RlVHlwZXMpIHtcbiAgICAgICAgaGFzVHlwZSA9IGZhbHNlO1xuICAgICAgICB0eXBlU3RyaW5nID0gJ05vIGV4cHJlc3Npb24gYXQgdGhlIGdpdmVuIHJhbmdlJztcbiAgICB9IGVsc2Uge1xuICAgICAgICBoYXNUeXBlID0gdHJ1ZTtcbiAgICAgICAgdHlwZVN0cmluZyA9ICcnO1xuICAgICAgICBub2RlVHlwZXMuZm9yRWFjaChmdW5jdGlvbiAodHAsIGkpIHtcbiAgICAgICAgICAgIHR5cGVTdHJpbmcgKz0gdHAuZ2V0TmFtZSgpO1xuICAgICAgICAgICAgaWYgKGkgIT09IG5vZGVUeXBlcy5sZW5ndGggLSAxKSB7XG4gICAgICAgICAgICAgICAgdHlwZVN0cmluZyArPSAnLCAnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgICAgaGFzVHlwZTogaGFzVHlwZSxcbiAgICAgICAgdHlwZVN0cmluZzogdHlwZVN0cmluZyxcbiAgICAgICAgbm9kZVN0YXJ0OiBub2RlLnN0YXJ0LFxuICAgICAgICBub2RlRW5kOiBub2RlLmVuZFxuICAgIH07XG59XG5cbmV4cG9ydHMuZ2V0VHlwZURhdGEgPSBnZXRUeXBlRGF0YTsiLCIvLyBpbXBvcnQgbmVjZXNzYXJ5IGxpYnJhcmllc1xuY29uc3QgYWNvcm4gPSByZXF1aXJlKCdhY29ybi9kaXN0L2Fjb3JuJyk7XG5jb25zdCBhY29ybl9sb29zZSA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3QvYWNvcm5fbG9vc2UnKTtcbmNvbnN0IGF1eCA9IHJlcXVpcmUoJy4vYXV4Jyk7XG5jb25zdCB0eXBlcyA9IHJlcXVpcmUoJy4vZG9tYWlucy90eXBlcycpO1xuY29uc3QgY29udGV4dCA9IHJlcXVpcmUoJy4vZG9tYWlucy9jb250ZXh0Jyk7XG5jb25zdCBzdGF0dXMgPSByZXF1aXJlKCcuL2RvbWFpbnMvc3RhdHVzJyk7XG5jb25zdCB2YXJCbG9jayA9IHJlcXVpcmUoJy4vdmFyQmxvY2snKTtcbmNvbnN0IGNHZW4gPSByZXF1aXJlKCcuL2NvbnN0cmFpbnQvY0dlbicpO1xuY29uc3QgdmFyUmVmcyA9IHJlcXVpcmUoJy4vdmFycmVmcycpO1xuY29uc3QgcmV0T2NjdXIgPSByZXF1aXJlKCcuL3JldE9jY3VyJyk7XG5jb25zdCB0aGlzT2NjdXIgPSByZXF1aXJlKCcuL3RoaXNPY2N1cicpO1xuY29uc3QgbXlXYWxrZXIgPSByZXF1aXJlKCcuL3V0aWwvbXlXYWxrZXInKTtcbmNvbnN0IGdldFR5cGVEYXRhID0gcmVxdWlyZSgnLi9nZXRUeXBlRGF0YScpO1xuXG5mdW5jdGlvbiBhbmFseXplKGlucHV0LCByZXRBbGwpIHtcbiAgICAvLyB0aGUgU2NvcGUgb2JqZWN0IGZvciBnbG9iYWwgc2NvcGVcbiAgICAvLyBzY29wZS5TY29wZS5nbG9iYWxTY29wZSA9IG5ldyBzY29wZS5TY29wZShudWxsKTtcblxuICAgIC8vIHBhcnNpbmcgaW5wdXQgcHJvZ3JhbVxuICAgIHZhciBhc3Q7XG4gICAgY29uc3QgYWNvcm5PcHRpb25zID0ge2VjbWFWZXJzaW9uOiA2fTtcbiAgICB0cnkge1xuICAgICAgICBhc3QgPSBhY29ybi5wYXJzZShpbnB1dCwgYWNvcm5PcHRpb25zKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGFzdCA9IGFjb3JuX2xvb3NlLnBhcnNlX2RhbW1pdChpbnB1dCwgYWNvcm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB2YXIgbm9kZUFycmF5SW5kZXhlZEJ5TGlzdCA9IGF1eC5nZXROb2RlTGlzdChhc3QpO1xuXG4gICAgLy8gU2hvdyBBU1QgYmVmb3JlIHNjb3BlIHJlc29sdXRpb25cbiAgICAvLyBhdXguc2hvd1VuZm9sZGVkKGFzdCk7XG5cbiAgICB2YXJCbG9jay5hbm5vdGF0ZUJsb2NrSW5mbyhhc3QpO1xuICAgIHZhciBnQmxvY2sgPSBhc3RbJ0BibG9jayddO1xuICAgIHZhciBpbml0aWFsQ29udGV4dCA9IG5ldyBjb250ZXh0LkNhbGxTaXRlQ29udGV4dDtcbiAgICB2YXIgZ1Njb3BlID0gZ0Jsb2NrLmdldFNjb3BlSW5zdGFuY2UobnVsbCwgaW5pdGlhbENvbnRleHQpO1xuICAgIHZhciBnT2JqZWN0ID0gdHlwZXMubWtPYmpGcm9tR2xvYmFsU2NvcGUoZ1Njb3BlKTtcbiAgICB2YXIgaW5pdFN0YXR1cyA9IG5ldyBzdGF0dXMuU3RhdHVzKFxuICAgICAgICBnT2JqZWN0LFxuICAgICAgICB0eXBlcy5BVmFsTnVsbCxcbiAgICAgICAgdHlwZXMuQVZhbE51bGwsXG4gICAgICAgIGluaXRpYWxDb250ZXh0LFxuICAgICAgICBnU2NvcGUpO1xuICAgIC8vIHRoZSBwcm90b3R5cGUgb2JqZWN0IG9mIE9iamVjdFxuICAgIHZhciBPYmpQcm90byA9IG5ldyB0eXBlcy5PYmpUeXBlKG51bGwsICdPYmplY3QucHJvdG90eXBlJyk7XG4gICAgdmFyIHJ0Q1ggPSB7XG4gICAgICAgIGdsb2JhbE9iamVjdDogZ09iamVjdCxcbiAgICAgICAgLy8gdGVtcG9yYWxcbiAgICAgICAgcHJvdG9zOiB7XG4gICAgICAgICAgICBPYmplY3Q6IE9ialByb3RvLFxuICAgICAgICAgICAgRnVuY3Rpb246IG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKE9ialByb3RvKSwgJ0Z1bmN0aW9uLnByb3RvdHlwZScpLFxuICAgICAgICAgICAgQXJyYXk6IG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKE9ialByb3RvKSwgJ0FycmF5LnByb3RvdHlwZScpLFxuICAgICAgICAgICAgUmVnRXhwOiBuZXcgdHlwZXMuT2JqVHlwZShuZXcgdHlwZXMuQVZhbChPYmpQcm90byksICdSZWdFeHAucHJvdG90eXBlJyksXG4gICAgICAgICAgICBTdHJpbmc6IG5ldyB0eXBlcy5PYmpUeXBlKG5ldyB0eXBlcy5BVmFsKE9ialByb3RvKSwgJ1N0cmluZy5wcm90b3R5cGUnKSxcbiAgICAgICAgICAgIE51bWJlcjogbmV3IHR5cGVzLk9ialR5cGUobmV3IHR5cGVzLkFWYWwoT2JqUHJvdG8pLCAnTnVtYmVyLnByb3RvdHlwZScpLFxuICAgICAgICAgICAgQm9vbGVhbjogbmV3IHR5cGVzLk9ialR5cGUobmV3IHR5cGVzLkFWYWwoT2JqUHJvdG8pLCAnQm9vbGVhbi5wcm90b3R5cGUnKVxuICAgICAgICB9LFxuICAgICAgICDEiDogbmV3IHR5cGVzLkFic0NhY2hlKClcbiAgICB9O1xuICAgIGNHZW4uYWRkQ29uc3RyYWludHMoYXN0LCBpbml0U3RhdHVzLCBydENYKTtcbiAgICB2YXIgY29uc3RyYWludHMgPSBjR2VuLmNvbnN0cmFpbnRzO1xuICAgIC8vYXV4LnNob3dVbmZvbGRlZChnQmxvY2tBbmRBbm5vdGF0ZWRBU1QuYXN0KTtcbiAgICAvLyBhdXguc2hvd1VuZm9sZGVkKGNvbnN0cmFpbnRzKTtcbiAgICAvLyBhdXguc2hvd1VuZm9sZGVkKGdCbG9jayk7XG4gICAgLy8gY29uc29sZS5sb2codXRpbC5pbnNwZWN0KGdCbG9jaywge2RlcHRoOiAxMH0pKTtcbiAgICBpZiAocmV0QWxsKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBnT2JqZWN0OiBnT2JqZWN0LFxuICAgICAgICAgICAgQVNUOiBhc3QsXG4gICAgICAgICAgICBnQmxvY2s6IGdCbG9jayxcbiAgICAgICAgICAgIGdTY29wZTogZ1Njb3BlLFxuICAgICAgICAgICAgxIg6IHJ0Q1guxIhcbiAgICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gZ09iamVjdDtcbiAgICB9XG59XG5cbmV4cG9ydHMuYW5hbHl6ZSA9IGFuYWx5emU7XG5leHBvcnRzLmZpbmRJZGVudGlmaWVyQXQgPSB2YXJSZWZzLmZpbmRJZGVudGlmaWVyQXQ7XG5leHBvcnRzLmZpbmRWYXJSZWZzQXQgPSB2YXJSZWZzLmZpbmRWYXJSZWZzQXQ7XG5leHBvcnRzLm9uRnVuY3Rpb25PclJldHVybktleXdvcmQgPSByZXRPY2N1ci5vbkZ1bmN0aW9uT3JSZXR1cm5LZXl3b3JkO1xuZXhwb3J0cy5maW5kUmV0dXJuU3RhdGVtZW50cyA9IHJldE9jY3VyLmZpbmRSZXR1cm5TdGF0ZW1lbnRzO1xuZXhwb3J0cy5vblRoaXNLZXl3b3JkID0gdGhpc09jY3VyLm9uVGhpc0tleXdvcmQ7XG5leHBvcnRzLmZpbmRUaGlzRXhwcmVzc2lvbnMgPSB0aGlzT2NjdXIuZmluZFRoaXNFeHByZXNzaW9ucztcbmV4cG9ydHMuZmluZFN1cnJvdW5kaW5nTm9kZSA9IG15V2Fsa2VyLmZpbmRTdXJyb3VuZGluZ05vZGU7XG5leHBvcnRzLmdldFR5cGVEYXRhID0gZ2V0VHlwZURhdGEuZ2V0VHlwZURhdGE7XG4iLCJjb25zdCB3YWxrID0gcmVxdWlyZSgnYWNvcm4vZGlzdC93YWxrJyk7XG5jb25zdCBteVdhbGtlciA9IHJlcXVpcmUoJy4vdXRpbC9teVdhbGtlcicpO1xuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgZ2l2ZW4gcG9zIGlzIG9uIGEgZnVuY3Rpb24ga2V5d29yZFxuICogQHBhcmFtIGFzdCAtIEFTVCBvZiBhIHByb2dyYW1cbiAqIEBwYXJhbSBwb3MgLSBpbmRleCBwb3NpdGlvblxuICogQHJldHVybnMgeyp9IC0gZnVuY3Rpb24gbm9kZSBvciBudWxsXG4gKi9cbmZ1bmN0aW9uIG9uRnVuY3Rpb25PclJldHVybktleXdvcmQoYXN0LCBwb3MpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIC8vIGZpbmQgZnVuY3Rpb24gbm9kZVxuICAgIC8vIHN0IGlzIHRoZSBlbmNsb3NpbmcgZnVuY3Rpb25cbiAgICBjb25zdCB3YWxrZXIgPSBteVdhbGtlci53cmFwV2Fsa2VyKHdhbGsuYmFzZSxcbiAgICAgICAgLy8gcHJlXG4gICAgICAgIChub2RlLCBzdCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5vZGUuc3RhcnQgPiBwb3MgfHwgbm9kZS5lbmQgPCBwb3MpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIG9uIGEgZnVuY3Rpb24ga2V5d29yZCwgOCBpcyB0aGUgbGVuZ3RoIG9mICdmdW5jdGlvbidcbiAgICAgICAgICAgIC8vIG9yIG9uIHJldHVybiBrZXl3b3JkLCA2IGlzIHRoZSBsZW5ndGggb2YgJ3JldHVybidcbiAgICAgICAgICAgIGlmICgoKG5vZGUudHlwZSA9PT0gJ0Z1bmN0aW9uRGVjbGFyYXRpb24nIHx8IG5vZGUudHlwZSA9PT0gJ0Z1bmN0aW9uRXhwcmVzc2lvbicpXG4gICAgICAgICAgICAgICAgJiYgKG5vZGUuc3RhcnQgPD0gcG9zICYmIHBvcyA8PSBub2RlLnN0YXJ0ICsgOCkpXG4gICAgICAgICAgICAgICAgfHxcbiAgICAgICAgICAgICAgICAobm9kZS50eXBlID09PSAnUmV0dXJuU3RhdGVtZW50J1xuICAgICAgICAgICAgICAgICYmIChub2RlLnN0YXJ0IDw9IHBvcyAmJiBwb3MgPD0gbm9kZS5zdGFydCArIDYpKSkge1xuICAgICAgICAgICAgICAgIHRocm93IHN0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG4gICAgICAgIC8vIHBvc3RcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICAvLyBzdENoYW5nZVxuICAgICAgICAobm9kZSwgc3QpID0+IHtcbiAgICAgICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdGdW5jdGlvbkRlY2xhcmF0aW9uJ1xuICAgICAgICAgICAgICAgIHx8IG5vZGUudHlwZSA9PT0gJ0Z1bmN0aW9uRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbm9kZTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN0O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgIHRyeSB7XG4gICAgICAgIHdhbGsucmVjdXJzaXZlKGFzdCwgdW5kZWZpbmVkLCB3YWxrZXIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKGUgJiYgZS50eXBlICYmXG4gICAgICAgICAgICAoZS50eXBlID09PSAnRnVuY3Rpb25FeHByZXNzaW9uJ1xuICAgICAgICAgICAgfHwgZS50eXBlID09PSAnRnVuY3Rpb25EZWNsYXJhdGlvbicpKSB7XG4gICAgICAgICAgICByZXR1cm4gZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IGU7XG4gICAgICAgIH1cbiAgICB9XG4gICAgLy8gaWRlbnRpZmllciBub3QgZm91bmRcbiAgICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBHaXZlbiBhIGZ1bmN0aW9uIG5vZGUsIGZpbmQgaXRzIHJldHVybiBub2Rlc1xuICpcbiAqIEBwYXJhbSBmTm9kZSAtIEFTVCBub2RlIG9mIGEgZnVuY3Rpb24sIHBvc3NpYmx5IHdpdGggbm8gYW5ub3RhdGlvblxuICogQHJldHVybnMgeyp9IC0gYXJyYXkgb2YgQVNUIG5vZGVzXG4gKi9cbmZ1bmN0aW9uIGdldFJldHVybk5vZGVzKGZOb2RlKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgY29uc3QgcmV0cyA9IFtdO1xuICAgIGlmIChmTm9kZS50eXBlICE9PSAnRnVuY3Rpb25FeHByZXNzaW9uJ1xuICAgICAgICAmJiBmTm9kZS50eXBlICE9PSAnRnVuY3Rpb25EZWNsYXJhdGlvbicpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ2ZOb2RlIHNob3VsZCBiZSBhIGZ1bmN0aW9uIG5vZGUnKTtcbiAgICB9XG5cbiAgICBjb25zdCB3YWxrZXIgPSB3YWxrLm1ha2Uoe1xuICAgICAgICBSZXR1cm5TdGF0ZW1lbnQ6IChub2RlKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gcmV0cy5wdXNoKG5vZGUpO1xuICAgICAgICB9LFxuICAgICAgICBGdW5jdGlvbjogKCkgPT4ge1xuICAgICAgICAgICAgLy8gbm90IHZpc2l0IGlubmVyIGZ1bmN0aW9uc1xuICAgICAgICB9XG4gICAgfSwgd2Fsay5iYXNlKTtcblxuICAgIHdhbGsucmVjdXJzaXZlKGZOb2RlLmJvZHksIHVuZGVmaW5lZCwgd2Fsa2VyKTtcblxuICAgIHJldHVybiByZXRzO1xufVxuXG4vKipcbiAqIEZpbmQgcmV0dXJuIG5vZGVzIGNvcnJlc3BvbmRpbmcgdG8gdGhlIHBvc2l0aW9uXG4gKiBpZiB0aGUgcG9zIGlzIG9uIGEgZnVuY3Rpb24ga2V5d29yZFxuICpcbiAqIEBwYXJhbSBhc3QgLSBBU1Qgbm9kZSBvZiBhIHByb2dyYW0sIHBvc3NpYmx5IHdpdGggbm8gYW5ub3RhdGlvblxuICogQHBhcmFtIHBvcyAtIGN1cnNvciBwb3NpdGlvblxuICogQHBhcmFtIGluY2x1ZGVGdW5jdGlvbktleXdvcmQgLSB3aGV0aGVyIHRvIGluY2x1ZGUgZnVuY3Rpb24ga2V5d29yZCByYW5nZVxuICogQHJldHVybnMge0FycmF5fSAtIGFycmF5IG9mIEFTVCBub2RlcyBvZiByZXR1cm4gc3RhdGVtZW50c1xuICovXG5mdW5jdGlvbiBmaW5kUmV0dXJuU3RhdGVtZW50cyhhc3QsIHBvcywgaW5jbHVkZUZ1bmN0aW9uS2V5d29yZCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuXG4gICAgY29uc3QgZk5vZGUgPSBvbkZ1bmN0aW9uT3JSZXR1cm5LZXl3b3JkKGFzdCwgcG9zKTtcbiAgICBpZiAoIWZOb2RlKSB7XG4gICAgICAgIC8vIHBvcyBpcyBub3Qgb24gZnVuY3Rpb24ga2V5d29yZFxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCByZXRzID0gZ2V0UmV0dXJuTm9kZXMoZk5vZGUpO1xuICAgIC8vIHdoZW4gZnVuY3Rpb24gZG9lcyBub3QgaGF2ZSByZXR1cm4gc3RhdGVtZW50cyxcbiAgICAvLyBpbmRpY2F0ZSBpdCBieSB0aGUgY2xvc2luZyBicmFjZSBvZiB0aGUgZnVuY3Rpb24gYm9keVxuICAgIGlmIChyZXRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXRzLnB1c2goe3N0YXJ0OiBmTm9kZS5lbmQgLSAxLCBlbmQ6IGZOb2RlLmVuZH0pO1xuICAgIH1cbiAgICBpZiAoaW5jbHVkZUZ1bmN0aW9uS2V5d29yZCkge1xuICAgICAgICByZXRzLnB1c2goe3N0YXJ0OiBmTm9kZS5zdGFydCwgZW5kOiBmTm9kZS5zdGFydCArIDh9KTtcbiAgICB9XG4gICAgcmV0dXJuIHJldHM7XG59XG5cbmV4cG9ydHMub25GdW5jdGlvbk9yUmV0dXJuS2V5d29yZCA9IG9uRnVuY3Rpb25PclJldHVybktleXdvcmQ7XG5leHBvcnRzLmZpbmRSZXR1cm5TdGF0ZW1lbnRzID0gZmluZFJldHVyblN0YXRlbWVudHM7IiwiY29uc3Qgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xuY29uc3QgbXlXYWxrZXIgPSByZXF1aXJlKCcuL3V0aWwvbXlXYWxrZXInKTtcblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGdpdmVuIHBvcyBpcyBvbiBhIHRoaXMga2V5d29yZFxuICogQHBhcmFtIGFzdCAtIEFTVCBvZiBhIHByb2dyYW1cbiAqIEBwYXJhbSBwb3MgLSBpbmRleCBwb3NpdGlvblxuICogQHJldHVybnMgeyp9IC0gZnVuY3Rpb24gbm9kZSBvciBudWxsXG4gKi9cbmZ1bmN0aW9uIG9uVGhpc0tleXdvcmQoYXN0LCBwb3MpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcblxuICAgIC8vIGZpbmQgZnVuY3Rpb24gbm9kZVxuICAgIC8vIHN0IGlzIHRoZSBlbmNsb3NpbmcgZnVuY3Rpb25cbiAgICBjb25zdCB3YWxrZXIgPSBteVdhbGtlci53cmFwV2Fsa2VyKHdhbGsuYmFzZSxcbiAgICAgICAgLy8gcHJlXG4gICAgICAgIChub2RlLCBzdCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5vZGUuc3RhcnQgPiBwb3MgfHwgbm9kZS5lbmQgPCBwb3MpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChub2RlLnR5cGUgPT09ICdUaGlzRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBzdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LFxuICAgICAgICAvLyBwb3N0XG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgLy8gc3RDaGFuZ2VcbiAgICAgICAgKG5vZGUsIHN0KSA9PiB7XG4gICAgICAgICAgICBpZiAobm9kZS50eXBlID09PSAnRnVuY3Rpb25EZWNsYXJhdGlvbidcbiAgICAgICAgICAgICAgICB8fCBub2RlLnR5cGUgPT09ICdGdW5jdGlvbkV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5vZGU7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBzdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICB0cnkge1xuICAgICAgICB3YWxrLnJlY3Vyc2l2ZShhc3QsIHVuZGVmaW5lZCwgd2Fsa2VyKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmIChlICYmIGUudHlwZSAmJlxuICAgICAgICAgICAgKGUudHlwZSA9PT0gJ0Z1bmN0aW9uRXhwcmVzc2lvbidcbiAgICAgICAgICAgIHx8IGUudHlwZSA9PT0gJ0Z1bmN0aW9uRGVjbGFyYXRpb24nKSkge1xuICAgICAgICAgICAgcmV0dXJuIGU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgfVxuICAgIC8vIGlkZW50aWZpZXIgbm90IGZvdW5kXG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogR2l2ZW4gYSBmdW5jdGlvbiBub2RlLCBmaW5kIGl0cyB0aGlzIG5vZGVzXG4gKlxuICogQHBhcmFtIGZOb2RlIC0gQVNUIG5vZGUgb2YgYSBmdW5jdGlvbiwgcG9zc2libHkgd2l0aCBubyBhbm5vdGF0aW9uXG4gKiBAcmV0dXJucyB7Kn0gLSBhcnJheSBvZiBBU1Qgbm9kZXNcbiAqL1xuZnVuY3Rpb24gZ2V0VGhpc05vZGVzKGZOb2RlKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgY29uc3QgcmV0cyA9IFtdO1xuICAgIGlmIChmTm9kZS50eXBlICE9PSAnRnVuY3Rpb25FeHByZXNzaW9uJ1xuICAgICAgICAmJiBmTm9kZS50eXBlICE9PSAnRnVuY3Rpb25EZWNsYXJhdGlvbicpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ2ZOb2RlIHNob3VsZCBiZSBhIGZ1bmN0aW9uIG5vZGUnKTtcbiAgICB9XG5cbiAgICBjb25zdCB3YWxrZXIgPSB3YWxrLm1ha2Uoe1xuICAgICAgICBUaGlzRXhwcmVzc2lvbjogKG5vZGUpID0+IHtcbiAgICAgICAgICAgIHJldHVybiByZXRzLnB1c2gobm9kZSk7XG4gICAgICAgIH0sXG4gICAgICAgIEZ1bmN0aW9uOiAoKSA9PiB7XG4gICAgICAgICAgICAvLyBub3QgdmlzaXQgaW5uZXIgZnVuY3Rpb25zXG4gICAgICAgIH1cbiAgICB9LCB3YWxrLmJhc2UpO1xuXG4gICAgd2Fsay5yZWN1cnNpdmUoZk5vZGUuYm9keSwgdW5kZWZpbmVkLCB3YWxrZXIpO1xuXG4gICAgcmV0dXJuIHJldHM7XG59XG5cbi8qKlxuICogRmluZCB0aGlzIG5vZGVzIGlmIHRoZSBwb3MgaXMgb24gYSB0aGlzIGtleXdvcmRcbiAqXG4gKiBAcGFyYW0gYXN0IC0gQVNUIG5vZGUgb2YgYSBwcm9ncmFtLCBwb3NzaWJseSB3aXRoIG5vIGFubm90YXRpb25cbiAqIEBwYXJhbSBwb3MgLSBjdXJzb3IgcG9zaXRpb25cbiAqIEBwYXJhbSBpbmNsdWRlRnVuY3Rpb25LZXl3b3JkIC0gd2hldGhlciB0byBpbmNsdWRlIGZ1bmN0aW9uIGtleXdvcmQgcmFuZ2VcbiAqIEByZXR1cm5zIHtBcnJheX0gLSBhcnJheSBvZiBBU1Qgbm9kZXMgb2YgcmV0dXJuIHN0YXRlbWVudHNcbiAqL1xuZnVuY3Rpb24gZmluZFRoaXNFeHByZXNzaW9ucyhhc3QsIHBvcywgaW5jbHVkZUZ1bmN0aW9uS2V5d29yZCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuXG4gICAgY29uc3QgZk5vZGUgPSBvblRoaXNLZXl3b3JkKGFzdCwgcG9zKTtcbiAgICBpZiAoIWZOb2RlKSB7XG4gICAgICAgIC8vIHBvcyBpcyBub3Qgb24gdGhpcyBrZXl3b3JkXG4gICAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IHJldHMgPSBnZXRUaGlzTm9kZXMoZk5vZGUpO1xuICAgIGlmIChpbmNsdWRlRnVuY3Rpb25LZXl3b3JkKSB7XG4gICAgICAgIHJldHMucHVzaCh7c3RhcnQ6IGZOb2RlLnN0YXJ0LCBlbmQ6IGZOb2RlLnN0YXJ0ICsgOH0pO1xuICAgIH1cbiAgICByZXR1cm4gcmV0cztcbn1cblxuZXhwb3J0cy5vblRoaXNLZXl3b3JkID0gb25UaGlzS2V5d29yZDtcbmV4cG9ydHMuZmluZFRoaXNFeHByZXNzaW9ucyA9IGZpbmRUaGlzRXhwcmVzc2lvbnM7IiwiY29uc3Qgd2FsayA9IHJlcXVpcmUoJ2Fjb3JuL2Rpc3Qvd2FsaycpO1xuXG4vKipcbiAqIGEgd2Fsa2VyIHRoYXQgdmlzaXRzIGVhY2ggaWQgZXZlbiB0aG91Z2ggaXQgaXMgdmFyIGRlY2xhcmF0aW9uXG4gKiB0aGUgcGFyYW1ldGVyIHZiIGRlbm90ZSB2YXJCbG9ja1xuICovXG5jb25zdCB2YXJXYWxrZXI9IHdhbGsubWFrZSh7XG4gICAgRnVuY3Rpb246IGZ1bmN0aW9uIChub2RlLCB2YiwgYykge1xuICAgICAgICAndXNlIHN0cmljdCc7XG4gICAgICAgIGNvbnN0IGlubmVyVmIgPSBub2RlLmJvZHlbJ0BibG9jayddO1xuICAgICAgICBpZiAobm9kZS5pZCkgYyhub2RlLmlkLCBpbm5lclZiKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBub2RlLnBhcmFtcy5sZW5ndGg7IGkrKylcbiAgICAgICAgICAgIGMobm9kZS5wYXJhbXNbaV0sIGlubmVyVmIpO1xuICAgICAgICBjKG5vZGUuYm9keSwgaW5uZXJWYik7XG4gICAgfSxcbiAgICBUcnlTdGF0ZW1lbnQ6IGZ1bmN0aW9uIChub2RlLCB2YiwgYykge1xuICAgICAgICBjKG5vZGUuYmxvY2ssIHZiKTtcbiAgICAgICAgaWYgKG5vZGUuaGFuZGxlcikge1xuICAgICAgICAgICAgYyhub2RlLmhhbmRsZXIsIHZiKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobm9kZS5maW5hbGl6ZXIpIHtcbiAgICAgICAgICAgIGMobm9kZS5maW5hbGl6ZXIsIHZiKTtcbiAgICAgICAgfVxuICAgIH0sXG4gICAgQ2F0Y2hDbGF1c2U6IGZ1bmN0aW9uIChub2RlLCB2YiwgYykge1xuICAgICAgICBjb25zdCBjYXRjaFZiID0gbm9kZS5ib2R5WydAYmxvY2snXTtcbiAgICAgICAgYyhub2RlLnBhcmFtLCBjYXRjaFZiKTtcbiAgICAgICAgYyhub2RlLmJvZHksIGNhdGNoVmIpO1xuICAgIH0sXG4gICAgVmFyaWFibGVEZWNsYXJhdGlvbjogZnVuY3Rpb24gKG5vZGUsIHZiLCBjKSB7XG4gICAgICAgICd1c2Ugc3RyaWN0JztcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBub2RlLmRlY2xhcmF0aW9ucy5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgY29uc3QgZGVjbCA9IG5vZGUuZGVjbGFyYXRpb25zW2ldO1xuICAgICAgICAgICAgYyhkZWNsLmlkLCB2Yik7XG4gICAgICAgICAgICBpZiAoZGVjbC5pbml0KSBjKGRlY2wuaW5pdCwgdmIpO1xuICAgICAgICB9XG4gICAgfSxcbiAgICBWYXJpYWJsZVBhdHRlcm46IGZ1bmN0aW9uIChub2RlLCB2YiwgYykge1xuICAgICAgICAndXNlIHN0cmljdCc7XG4gICAgICAgIGMobm9kZSwgdmIsICdJZGVudGlmaWVyJyk7XG4gICAgfVxufSk7XG5cbi8qKlxuICogV3JhcCBhIHdhbGtlciB3aXRoIHByZS0gYW5kIHBvc3QtIGFjdGlvbnNcbiAqXG4gKiBAcGFyYW0gcHJlTm9kZSAtIEFwcGx5IGJlZm9yZSB2aXNpdGluZyB0aGUgY3VycmVudCBub2RlLlxuICogSWYgcmV0dXJucyBmYWxzZSwgZG8gbm90IHZpc2l0IHRoZSBub2RlLlxuICogQHBhcmFtIHBvc3ROb2RlIC0gQXBwbHkgYWZ0ZXIgdmlzaXRpbmcgdGhlIGN1cnJlbnQgbm9kZS5cbiAqIElmIGdpdmVuLCByZXR1cm4gdmFsdWVzIGFyZSBvdmVycmlkZGVuLlxuICogQHJldHVybnMgeyp9IC0gYSBuZXcgd2Fsa2VyXG4gKi9cbmZ1bmN0aW9uIHdyYXBXYWxrZXIod2Fsa2VyLCBwcmVOb2RlLCBwb3N0Tm9kZSwgc3RDaGFuZ2UpIHtcbiAgICAndXNlIHN0cmljdCc7XG4gICAgY29uc3QgcmV0V2Fsa2VyID0ge307XG4gICAgLy8gd3JhcHBpbmcgZWFjaCBmdW5jdGlvbiBwcmVOb2RlIGFuZCBwb3N0Tm9kZVxuICAgIGZvciAobGV0IG5vZGVUeXBlIGluIHdhbGtlcikge1xuICAgICAgICBpZiAoIXdhbGtlci5oYXNPd25Qcm9wZXJ0eShub2RlVHlwZSkpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldFdhbGtlcltub2RlVHlwZV0gPSAobm9kZSwgc3QsIGMpID0+IHtcbiAgICAgICAgICAgIGxldCByZXQ7XG4gICAgICAgICAgICBsZXQgbmV3U3QgPSBzdDtcbiAgICAgICAgICAgIGlmIChzdENoYW5nZSkge1xuICAgICAgICAgICAgICAgIG5ld1N0ID0gc3RDaGFuZ2Uobm9kZSwgc3QpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFwcmVOb2RlIHx8IHByZU5vZGUobm9kZSwgbmV3U3QsIGMpKSB7XG4gICAgICAgICAgICAgICAgcmV0ID0gd2Fsa2VyW25vZGVUeXBlXShub2RlLCBuZXdTdCwgYyk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChwb3N0Tm9kZSkge1xuICAgICAgICAgICAgICAgIHJldCA9IHBvc3ROb2RlKG5vZGUsIG5ld1N0LCBjKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldFdhbGtlcjtcbn1cblxuXG5mdW5jdGlvbiBmaW5kU3Vycm91bmRpbmdOb2RlKGFzdCwgc3RhcnQsIGVuZCkge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGZ1bmN0aW9uIEZvdW5kKG5vZGUpIHtcbiAgICAgICAgdGhpcy5ub2RlID0gbm9kZTtcbiAgICB9XG5cbiAgICBjb25zdCB3YWxrZXIgPSB3cmFwV2Fsa2VyKHZhcldhbGtlcixcbiAgICAgICAgbm9kZSA9PiAhKG5vZGUuc3RhcnQgPiBzdGFydCB8fCBub2RlLmVuZCA8IGVuZCksXG4gICAgICAgIG5vZGUgPT4geyB0aHJvdyBuZXcgRm91bmQobm9kZSk7IH1cbiAgICApO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgd2Fsay5yZWN1cnNpdmUoYXN0LCB1bmRlZmluZWQsIHdhbGtlcik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIEZvdW5kKSB7XG4gICAgICAgICAgICByZXR1cm4gZS5ub2RlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgIH1cbiAgICAvLyBub2RlIG5vdCBmb3VuZFxuICAgIHJldHVybiBudWxsO1xufVxuXG5leHBvcnRzLndyYXBXYWxrZXIgPSB3cmFwV2Fsa2VyO1xuZXhwb3J0cy52YXJXYWxrZXIgPSB2YXJXYWxrZXI7XG5leHBvcnRzLmZpbmRTdXJyb3VuZGluZ05vZGUgPSBmaW5kU3Vycm91bmRpbmdOb2RlOyIsIi8qXG4gSmF2YVNjcmlwdOuKlCBnbG9iYWwsIGZ1bmN0aW9uIGJsb2NrLCBjYXRjaCBibG9ja+yXkCDrs4DsiJjqsIAg64us66aw64ukLlxuIEVTNuuKlCDsnbzrsJggYmxvY2vsl5Drj4Qg64us66aw64ukLlxuXG4gVmFyQmxvY2vripQg6rCBIGJsb2Nr7JeQIOuLrOumsCDrs4DsiJjrk6TsnYQg64KY7YOA64K464ukLlxuIC0gcGFyZW4gICAgICA6IEJsb2NrVmFycywg67CU6rmlIGJsb2Nr7J2EIOuCmO2DgOuCtOuKlCDqsJ3ssrRcbiAtIG9yaWdpbkxhYmVsOiBudW1iZXIsIO2VtOuLuSBCbG9ja1ZhcnPqsIAg7ISg7Ja465CcIEFTVCBub2Rl7J2YIEBsYWJlbFxuICAgIG9yaWdpbuydtCDrkKAg7IiYIOyeiOuKlCBub2Rl64qUXG4gICAgRnVuY3Rpb24uYm9keSwgQ2F0Y2hDbGF1c2UuYmxvY2sg65GQ6rCA7KeA64ukLlxuICAgIOuRkOqwgOyngCDrqqjrkZAgQmxvY2tTdGF0ZW1lbnTsnbTri6QuXG4gLSBpc0NhdGNoICAgIDogYm9vbGVhbixcbiAgICogdHJ1ZSAgLT4gY2F0Y2ggYmxvY2tcbiAgICogZmFsc2UgLT4gZnVuY3Rpb24gYmxvY2ssIG9yIGdsb2JhbFxuXG4gLSBwYXJhbVZhck5hbWVzIDog66ek6rCc67OA7IiYIOydtOumhCDrqqnroZ0sIOunpOqwnCDrs4DsiJgg7Iic7ISc64yA66GcXG4gLSBsb2NhbFZhck5hbWVzIDog7KeA7JetIOuzgOyImCDsnbTrpoQg66qp66GdLCDsiJzshJwg66y07J2Y66+4XG4gICAgYXJndW1lbnRz66W8IOyCrOyaqe2VmOuKlCDqsr3smrAgbG9jYWxWYXJOYW1lc+yXkCDrk7HsnqXtlZjqs6AsXG4gICAgYXJndW1lbnRzIG9iamVjdOulvCDsgqzsmqntlZjrqbQgdXNlQXJndW1lbnRzT2JqZWN0ID09IHRydWVcblxuIC0gKG9wdGlvbmFsKSB1c2VBcmd1bWVudHNPYmplY3Q6IGJvb2xlYW5cbiAgICDtlajsiJggYm9keSBibG9ja+yduCDqsr3smrDsl5Drp4wg7IKs7JqpIOqwgOuKpVxuICAgICogdHJ1ZSAgOiBhcmd1bWVudHMgb2JqZWN06rCAIOyCrOyaqeuQmOyXiOuLpC5cbiAgICAgIOymiSDtlajsiJggYm9keeyXkOyEnCDrs4DsiJggYXJndW1lbnRz66W8IOyEoOyWuCDsl4bsnbQg7IKs7Jqp7ZaI64ukLlxuICAgICAg7J20IOqyveyasCwgYXJndW1lbnRz64qUIO2VqOyImOydmCDsp4Dsl60g67OA7IiY66GcIOuTseuhneuQnOuLpC5cbiAgICAqIGZhbHNlIOyduCDqsr3smrDripQg7JeG64ukLiDqt7jrn7TqsbDrqbQg7JWE7JiIIOuzgOyImCDsnpDssrTqsIAg7JeG64ukLlxuXG4gLSB1c2VkVmFyaWFibGVzIDog6rCBIGJsb2Nr7J2YIOunpOqwnOuzgOyImCwg7KeA7Jet67OA7IiYIOykkVxuICAg7IKs7Jqp65CY64qUIOychOy5mOqwgCDsnojripQg6rKD65Ok7J2YIOuqqeuhnVxuXG4gLSBpbnN0YW5jZXMgOiBEZWx0YSAtPiBWYXJCbG9ja+ydmCDrs4DsiJjrk6QgLT4gQVZhbFxuICAgZ2V0SW5zdGFuY2UoZGVsdGEpIOulvCDthrXtlbQg6rCZ7J2AIGRlbHRh64qUIOqwmeydgCBtYXBwaW5nIOyjvOqyjCDrp4zrk6xcblxuIC0gc2NvcGVJbnN0YW5jZXMgOiBbU2NvcGVdXG4gICDtmITsnqwgVmFyQmxvY2vsnYQg66eI7KeA66eJ7Jy866GcIO2VmOuKlCBTY29wZeulvCDrqqjrkZAg66qo7J2A64ukLlxuICAgZ2V0U2NvcGVJbnN0YW5jZShkZWx0YSwgcGFyZW4pIOydhCDthrXtlbQg6rCZ7J2AIHNjb3BlIGNoYWlu7J2AXG4gICDqsJnsnYAg6rCd7LK06rCAIOuQmOuPhOuhnSDrp4zrk6Dri6QuXG4qL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgdHlwZXMgPSByZXF1aXJlKCcuL2RvbWFpbnMvdHlwZXMnKTtcbnZhciB3YWxrID0gcmVxdWlyZSgnYWNvcm4vZGlzdC93YWxrJyk7XG52YXIgYXV4ID0gcmVxdWlyZSgnLi9hdXgnKTtcblxuZnVuY3Rpb24gVmFyQmxvY2socGFyZW4sIG9yaWdpbk5vZGUsIGlzQ2F0Y2gpIHtcbiAgICB0aGlzLnBhcmVuID0gcGFyZW47XG4gICAgdGhpcy5vcmlnaW5Ob2RlID0gb3JpZ2luTm9kZTtcbiAgICB0aGlzLm9yaWdpbkxhYmVsID0gb3JpZ2luTm9kZVsnQGxhYmVsJ107XG4gICAgdGhpcy5pc0NhdGNoID0gaXNDYXRjaDtcbiAgICB0aGlzLnBhcmFtVmFyTmFtZXMgPSBbXTtcbiAgICB0aGlzLmxvY2FsVmFyTmFtZXMgPSBbXTtcblxuICAgIHRoaXMudXNlZFZhcmlhYmxlcyA9IFtdO1xuICAgIC8vIHRoaXMudXNlQXJndW1lbnRzT2JqZWN0XG4gICAgdGhpcy5pbnN0YW5jZXMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICAgIHRoaXMuc2NvcGVJbnN0YW5jZXMgPSBbXTtcbn1cblxuVmFyQmxvY2sucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShudWxsKTtcblxuVmFyQmxvY2sucHJvdG90eXBlLmlzR2xvYmFsID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLnBhcmVuID09IG51bGw7XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmlzRnVuY3Rpb24gPSBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRoaXMucGFyZW4gIT0gbnVsbCAmJiB0aGlzLmxvY2FsVmFyTmFtZXMgIT0gbnVsbDtcbn07XG5WYXJCbG9jay5wcm90b3R5cGUuaXNDYXRjaEJsb2NrID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLmlzQ2F0Y2g7XG59O1xuXG5WYXJCbG9jay5wcm90b3R5cGUuZ2V0TG9jYWxWYXJOYW1lcyA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy5sb2NhbFZhck5hbWVzO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5nZXRQYXJhbVZhck5hbWVzID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLnBhcmFtVmFyTmFtZXM7XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmhhc0xvY2FsVmFyID0gZnVuY3Rpb24gKHZhck5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy5sb2NhbFZhck5hbWVzICYmIHRoaXMubG9jYWxWYXJOYW1lcy5pbmRleE9mKHZhck5hbWUpID4gLTE7XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmhhc1BhcmFtVmFyID0gZnVuY3Rpb24gKHZhck5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy5wYXJhbVZhck5hbWVzLmluZGV4T2YodmFyTmFtZSkgPiAtMTtcbn07XG5WYXJCbG9jay5wcm90b3R5cGUuaGFzVmFyID0gZnVuY3Rpb24gKHZhck5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy5oYXNQYXJhbVZhcih2YXJOYW1lKSB8fCB0aGlzLmhhc0xvY2FsVmFyKHZhck5hbWUpO1xufTtcblxuVmFyQmxvY2sucHJvdG90eXBlLmFkZERlY2xhcmVkTG9jYWxWYXIgPSBmdW5jdGlvbiAodmFyTmFtZSwgaXNGdW5EZWNsKSB7XG4gICAgdmFyIGN1cnJCbG9jayA9IHRoaXM7XG4gICAgLy8gcGVlbCBvZmYgaW5pdGlhbCBjYXRjaCBibG9ja3NcbiAgICAvLyBmb3IgZnVuY3Rpb24gZGVjbCwgc2tpcCBhbnkgY2F0Y2ggYmxvY2tzLFxuICAgIC8vIGZvciB2YXJpYWJsZSBkZWNsLCBza2lwIGNhdGNoIGJsb2NrIHdpdGggZGlmZmVyZW50IHZhck5hbWUuXG4gICAgd2hpbGUgKGN1cnJCbG9jay5pc0NhdGNoQmxvY2soKSAmJlxuICAgICAgICAgICAoaXNGdW5EZWNsIHx8ICFjdXJyQmxvY2suaGFzUGFyYW1WYXIodmFyTmFtZSkpKSB7XG4gICAgICAgIGN1cnJCbG9jayA9IGN1cnJCbG9jay5wYXJlbjtcbiAgICB9XG4gICAgLy8gaWYgYWxyZWFkeSBhZGRlZCwgZG8gbm90IGFkZFxuICAgIGlmICghY3VyckJsb2NrLmhhc1Zhcih2YXJOYW1lKSkge1xuICAgICAgICBjdXJyQmxvY2subG9jYWxWYXJOYW1lcy5wdXNoKHZhck5hbWUpO1xuICAgIH1cbiAgICAvLyByZXR1cm5zIHRoZSBibG9jayBvYmplY3QgdGhhdCBjb250YWlucyB0aGUgdmFyaWFibGVcbiAgICByZXR1cm4gY3VyckJsb2NrO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5hZGRQYXJhbVZhciA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgdGhpcy5wYXJhbVZhck5hbWVzLnB1c2godmFyTmFtZSk7XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmZpbmRWYXJJbkNoYWluID0gZnVuY3Rpb24gKHZhck5hbWUpIHtcbiAgICB2YXIgY3VyckJsb2NrID0gdGhpcztcbiAgICB3aGlsZSAoY3VyckJsb2NrICYmIGN1cnJCbG9jay5wYXJlbiAmJiAhY3VyckJsb2NrLmhhc1Zhcih2YXJOYW1lKSkge1xuICAgICAgICBjdXJyQmxvY2sgPSBjdXJyQmxvY2sucGFyZW47XG4gICAgfVxuICAgIC8vIGlmIG5vdCBmb3VuZCwgaXQgd2lsbCByZXR1cm4gdGhlIGdsb2JhbFxuICAgIHJldHVybiBjdXJyQmxvY2s7XG59O1xuXG5WYXJCbG9jay5wcm90b3R5cGUuYWRkVXNlZFZhciA9IGZ1bmN0aW9uICh2YXJOYW1lKSB7XG4gICAgaWYgKHRoaXMudXNlZFZhcmlhYmxlcy5pbmRleE9mKHZhck5hbWUpID09PSAtMSkge1xuICAgICAgICB0aGlzLnVzZWRWYXJpYWJsZXMucHVzaCh2YXJOYW1lKTtcbiAgICB9XG59O1xuVmFyQmxvY2sucHJvdG90eXBlLmdldFVzZWRWYXJOYW1lcyA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcy51c2VkVmFyaWFibGVzO1xufTtcblZhckJsb2NrLnByb3RvdHlwZS5pc1VzZWRWYXIgPSBmdW5jdGlvbiAodmFyTmFtZSkge1xuICAgIHJldHVybiB0aGlzLnVzZWRWYXJpYWJsZXMuaW5kZXhPZih2YXJOYW1lKSA+IC0xO1xufTtcblxuLy8gcmV0dXJucyBhIG1hcHBpbmdcblZhckJsb2NrLnByb3RvdHlwZS5nZXRJbnN0YW5jZSA9IGZ1bmN0aW9uIChkZWx0YSkge1xuICAgIGlmICh0aGlzLmluc3RhbmNlc1tkZWx0YV0pIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuaW5zdGFuY2VzW2RlbHRhXTtcbiAgICB9XG4gICAgLy8gY29uc3RydWN0IFZhck1hcFxuICAgIHZhciB2YXJNYXAgPSBuZXcgTWFwKCk7XG4gICAgdmFyIHZhck5hbWVzID0gdGhpcy5nZXRQYXJhbVZhck5hbWVzKCkuY29uY2F0KHRoaXMuZ2V0TG9jYWxWYXJOYW1lcygpKTtcblxuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdmFyTmFtZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyTWFwLnNldCh2YXJOYW1lc1tpXSwgbmV3IHR5cGVzLkFWYWwoKSk7XG4gICAgfVxuICAgIC8vIHJlbWVtYmVyIHRoZSBpbnN0YW5jZVxuICAgIHRoaXMuaW5zdGFuY2VzW2RlbHRhXSA9IHZhck1hcDtcbiAgICByZXR1cm4gdmFyTWFwO1xufTtcbi8vIHJldHVybnMgYW4gYXJyYXlcblZhckJsb2NrLnByb3RvdHlwZS5nZXRQYXJhbUFWYWxzID0gZnVuY3Rpb24gKGRlbHRhKSB7XG4gICAgdmFyIGluc3RhbmNlID0gdGhpcy5nZXRJbnN0YW5jZShkZWx0YSk7XG4gICAgdmFyIHBhcmFtcyA9IFtdO1xuICAgIHRoaXMuZ2V0UGFyYW1WYXJOYW1lcygpLmZvckVhY2goZnVuY3Rpb24gKG5hbWUpIHtcbiAgICAgICAgcGFyYW1zLnB1c2goaW5zdGFuY2VbYXV4LmludGVybmFsTmFtZShuYW1lKV0pO1xuICAgIH0pO1xuICAgIHJldHVybiBwYXJhbXM7XG59O1xuLy8gcmV0dXJucyBhbiBBVmFsXG5WYXJCbG9jay5wcm90b3R5cGUuZ2V0QXJndW1lbnRzQVZhbCA9IGZ1bmN0aW9uIChkZWx0YSkge1xuICAgIGlmICghdGhpcy51c2VBcmd1bWVudHNPYmplY3QpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgZm9yIHRoaXMgVmFyQmxvY2snKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuZ2V0SW5zdGFuY2UoZGVsdGEpW2F1eC5pbnRlcm5hbE5hbWUoJ2FyZ3VtZW50cycpXTtcbn07XG5cbi8vIGdldCBhIFNjb3BlIGluc3RhbmNlXG5WYXJCbG9jay5wcm90b3R5cGUuZ2V0U2NvcGVJbnN0YW5jZSA9IGZ1bmN0aW9uIChwYXJlbiwgZGVsdGEpIHtcbiAgICB2YXIgdmFyTWFwID0gdGhpcy5nZXRJbnN0YW5jZShkZWx0YSk7XG4gICAgdmFyIGZvdW5kID0gbnVsbDtcblxuICAgIHRoaXMuc2NvcGVJbnN0YW5jZXMuZm9yRWFjaChmdW5jdGlvbiAoc2MpIHtcbiAgICAgICAgaWYgKHNjLnBhcmVuID09PSBwYXJlbiAmJiBzYy52YXJNYXAgPT09IHZhck1hcCkgZm91bmQgPSBzYztcbiAgICB9KTtcblxuICAgIGlmIChmb3VuZCkge1xuICAgICAgICByZXR1cm4gZm91bmQ7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIG5ld1Njb3BlSW5zdGFuY2UgPSBuZXcgU2NvcGUocGFyZW4sIHZhck1hcCwgdGhpcyk7XG4gICAgICAgIHRoaXMuc2NvcGVJbnN0YW5jZXMucHVzaChuZXdTY29wZUluc3RhbmNlKTtcbiAgICAgICAgcmV0dXJuIG5ld1Njb3BlSW5zdGFuY2U7XG4gICAgfVxufTtcblxudmFyIGRlY2xhcmVkVmFyaWFibGVGaW5kZXIgPSB3YWxrLm1ha2Uoe1xuICAgRnVuY3Rpb246IGZ1bmN0aW9uIChub2RlLCBjdXJyQmxvY2ssIGMpIHtcbiAgICAgICAgdmFyIHBhcmVuQmxvY2sgPSBjdXJyQmxvY2s7XG4gICAgICAgIGlmIChub2RlLmlkKSB7XG4gICAgICAgICAgICB2YXIgZnVuY05hbWUgPSBub2RlLmlkLm5hbWU7XG4gICAgICAgICAgICBwYXJlbkJsb2NrID0gY3VyckJsb2NrLmFkZERlY2xhcmVkTG9jYWxWYXIoZnVuY05hbWUsIHRydWUpO1xuICAgICAgICB9XG4gICAgICAgIC8vIGNyZWF0ZSBhIFZhckJsb2NrIGZvciBmdW5jdGlvblxuICAgICAgICB2YXIgZnVuY0Jsb2NrID0gbmV3IFZhckJsb2NrKHBhcmVuQmxvY2ssIG5vZGUpO1xuICAgICAgICBub2RlLmJvZHlbJ0BibG9jayddID0gZnVuY0Jsb2NrO1xuICAgICAgICAvLyBhZGQgZnVuY3Rpb24gcGFyYW1ldGVycyB0byB0aGUgc2NvcGVcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLnBhcmFtcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgdmFyIHBhcmFtTmFtZSA9IG5vZGUucGFyYW1zW2ldLm5hbWU7XG4gICAgICAgICAgICBmdW5jQmxvY2suYWRkUGFyYW1WYXIocGFyYW1OYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBjKG5vZGUuYm9keSwgZnVuY0Jsb2NrLCB1bmRlZmluZWQpO1xuICAgIH0sXG4gICAgVmFyaWFibGVEZWNsYXJhdGlvbjogZnVuY3Rpb24gKG5vZGUsIGN1cnJCbG9jaywgYykge1xuICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuZGVjbGFyYXRpb25zLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgICB2YXIgZGVjbCA9IG5vZGUuZGVjbGFyYXRpb25zW2ldO1xuICAgICAgICAgICAgdmFyIG5hbWUgPSBkZWNsLmlkLm5hbWU7XG4gICAgICAgICAgICBjdXJyQmxvY2suYWRkRGVjbGFyZWRMb2NhbFZhcihuYW1lKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZGVjbC5pbml0KSBjKGRlY2wuaW5pdCwgY3VyckJsb2NrLCB1bmRlZmluZWQpO1xuICAgIH0sXG4gICAgVHJ5U3RhdGVtZW50OiBmdW5jdGlvbiAobm9kZSwgY3VyclNjb3BlLCBjKSB7XG4gICAgICAgIGMobm9kZS5ibG9jaywgY3VyclNjb3BlLCB1bmRlZmluZWQpO1xuICAgICAgICBpZiAobm9kZS5oYW5kbGVyKSB7XG4gICAgICAgICAgICBjKG5vZGUuaGFuZGxlciwgY3VyclNjb3BlLCB1bmRlZmluZWQpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChub2RlLmZpbmFsaXplcikge1xuICAgICAgICAgICAgYyhub2RlLmZpbmFsaXplciwgY3VyclNjb3BlLCB1bmRlZmluZWQpO1xuICAgICAgICB9XG4gICAgfSxcbiAgICBDYXRjaENsYXVzZTogZnVuY3Rpb24gKG5vZGUsIGN1cnJCbG9jaywgYykge1xuICAgICAgICB2YXIgY2F0Y2hCbG9jayA9IG5ldyBWYXJCbG9jayhjdXJyQmxvY2ssIG5vZGUsIHRydWUpO1xuICAgICAgICBjYXRjaEJsb2NrLmFkZFBhcmFtVmFyKG5vZGUucGFyYW0ubmFtZSk7XG4gICAgICAgIG5vZGUuYm9keVsnQGJsb2NrJ10gPSBjYXRjaEJsb2NrO1xuICAgICAgICBjKG5vZGUuYm9keSwgY2F0Y2hCbG9jaywgdW5kZWZpbmVkKTtcbiAgICB9XG59KTtcblxuLy8gRm9yIHZhcmlhYmxlcyBpbiBnbG9iYWwgYW5kIGFyZ3VtZW50cyBpbiBmdW5jdGlvbnNcbnZhciB2YXJpYWJsZVVzYWdlQ29sbGVjdG9yID0gd2Fsay5tYWtlKHtcbiAgICBWYXJpYWJsZVBhdHRlcm46IGZ1bmN0aW9uIChub2RlLCBjdXJyQmxvY2ssIGMpIHtcbiAgICAgICAgYyhub2RlLCBjdXJyQmxvY2ssICdJZGVudGlmaWVyJyk7XG4gICAgfSxcblxuICAgIElkZW50aWZpZXI6IGZ1bmN0aW9uIChub2RlLCBjdXJyQmxvY2ssIGMpIHtcbiAgICAgICAgdmFyIGNvbnRhaW5pbmdCbG9jaywgdmFyTmFtZSA9IG5vZGUubmFtZTtcbiAgICAgICAgaWYgKHZhck5hbWUgIT09ICdhcmd1bWVudHMnKSB7XG4gICAgICAgICAgICBjb250YWluaW5nQmxvY2sgPSBjdXJyQmxvY2suZmluZFZhckluQ2hhaW4odmFyTmFtZSk7XG4gICAgICAgICAgICBpZiAoY29udGFpbmluZ0Jsb2NrLmlzR2xvYmFsKCkpIHtcbiAgICAgICAgICAgICAgICBjb250YWluaW5nQmxvY2suYWRkRGVjbGFyZWRMb2NhbFZhcih2YXJOYW1lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRhaW5pbmdCbG9jay5hZGRVc2VkVmFyKHZhck5hbWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gdmFyTmFtZSA9PSAnYXJndW1lbnRzJ1xuICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrID0gY3VyckJsb2NrO1xuICAgICAgICAgICAgd2hpbGUgKGNvbnRhaW5pbmdCbG9jay5pc0NhdGNoQmxvY2soKSAmJlxuICAgICAgICAgICAgICAgICAgICAhY29udGFpbmluZ0Jsb2NrLmhhc1BhcmFtVmFyKHZhck5hbWUpKSB7XG4gICAgICAgICAgICAgICAgY29udGFpbmluZ0Jsb2NrID0gY29udGFpbmluZ0Jsb2NrLnBhcmVuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGNvbnRhaW5pbmdCbG9jay5oYXNWYXIodmFyTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAvLyBhcmd1bWVudHMgaXMgZXhwbGljaXRseSBkZWNsYXJlZFxuICAgICAgICAgICAgICAgIGNvbnRhaW5pbmdCbG9jay5hZGRVc2VkVmFyKHZhck5hbWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBhcmd1bWVudHMgaXMgbm90IGV4cGxpY2l0bHkgZGVjbGFyZWRcbiAgICAgICAgICAgICAgICAvLyBhZGQgaXQgYXMgbG9jYWwgdmFyaWFibGVcbiAgICAgICAgICAgICAgICBjb250YWluaW5nQmxvY2suYWRkRGVjbGFyZWRMb2NhbFZhcih2YXJOYW1lKTtcbiAgICAgICAgICAgICAgICAvLyBhbHNvIGl0IGlzIHVzZWRcbiAgICAgICAgICAgICAgICBjb250YWluaW5nQmxvY2suYWRkVXNlZFZhcih2YXJOYW1lKTtcbiAgICAgICAgICAgICAgICBpZiAoY29udGFpbmluZ0Jsb2NrLmlzRnVuY3Rpb24oKSkge1xuICAgICAgICAgICAgICAgICAgICBjb250YWluaW5nQmxvY2sudXNlQXJndW1lbnRzT2JqZWN0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9LFxuXG4gICAgUmV0dXJuU3RhdGVtZW50OiBmdW5jdGlvbiAobm9kZSwgY3VyckJsb2NrLCBjKSB7XG4gICAgICAgIHZhciBmdW5jdGlvbkJsb2NrID0gY3VyckJsb2NrO1xuICAgICAgICB3aGlsZSAoZnVuY3Rpb25CbG9jay5pc0NhdGNoQmxvY2soKSkge1xuICAgICAgICAgICAgZnVuY3Rpb25CbG9jayA9IGZ1bmN0aW9uQmxvY2sucGFyZW47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFmdW5jdGlvbkJsb2NrLmlzR2xvYmFsKCkgJiYgbm9kZS5hcmd1bWVudCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgZnVuY3Rpb25CbG9jay51c2VSZXR1cm5XaXRoQXJndW1lbnQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChub2RlLmFyZ3VtZW50KSB7XG4gICAgICAgICAgICBjKG5vZGUuYXJndW1lbnQsIGN1cnJCbG9jaywgdW5kZWZpbmVkKTtcbiAgICAgICAgfVxuICAgIH0sXG5cbiAgICBTY29wZUJvZHk6IGZ1bmN0aW9uIChub2RlLCBjdXJyQmxvY2ssIGMpIHtcbiAgICAgICAgYyhub2RlLCBub2RlWydAYmxvY2snXSB8fCBjdXJyQmxvY2spO1xuICAgIH1cbn0pO1xuXG5cbmZ1bmN0aW9uIGFubm90YXRlQmxvY2tJbmZvKGFzdCwgZ0Jsb2NrKSB7XG4gICAgaWYgKCFnQmxvY2spIHtcbiAgICAgICAgLy8gd2hlbiBnbG9iYWwgYmxvY2sgaXMgbm90IGdpdmVuLCBjcmVhdGVcbiAgICAgICAgZ0Jsb2NrID0gbmV3IFZhckJsb2NrKG51bGwsIGFzdCk7XG4gICAgfVxuICAgIGFzdFsnQGJsb2NrJ10gPSBnQmxvY2s7XG4gICAgd2Fsay5yZWN1cnNpdmUoYXN0LCBnQmxvY2ssIG51bGwsIGRlY2xhcmVkVmFyaWFibGVGaW5kZXIpO1xuICAgIHdhbGsucmVjdXJzaXZlKGFzdCwgZ0Jsb2NrLCBudWxsLCB2YXJpYWJsZVVzYWdlQ29sbGVjdG9yKTtcbiAgICByZXR1cm4gYXN0O1xufVxuXG4vLyBkZWZpbmUgc2NvcGUgb2JqZWN0XG5mdW5jdGlvbiBTY29wZShwYXJlbiwgdmFyTWFwLCB2Yikge1xuICAgIHRoaXMucGFyZW4gPSBwYXJlbjtcbiAgICB0aGlzLnZhck1hcCA9IHZhck1hcDtcbiAgICB0aGlzLnZiID0gdmI7XG59XG5TY29wZS5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuLy8gZmluZCBBVmFsIG9mIGEgdmFyaWFibGUgaW4gdGhlIGNoYWluXG5TY29wZS5wcm90b3R5cGUuZ2V0QVZhbE9mID0gZnVuY3Rpb24gKHZhck5hbWUpIHtcbiAgICB2YXIgY3VyciA9IHRoaXM7XG4gICAgd2hpbGUgKGN1cnIgIT0gbnVsbCkge1xuICAgICAgICBpZiAoY3Vyci52YXJNYXAuaGFzKHZhck5hbWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gY3Vyci52YXJNYXAuZ2V0KHZhck5hbWUpO1xuICAgICAgICB9XG4gICAgICAgIGN1cnIgPSBjdXJyLnBhcmVuO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1Nob3VsZCBoYXZlIGZvdW5kIHRoZSB2YXJpYWJsZScpO1xufTtcbi8vIHJlbW92ZSBpbml0aWFsIGNhdGNoIHNjb3BlcyBmcm9tIHRoZSBjaGFpblxuU2NvcGUucHJvdG90eXBlLnJlbW92ZUluaXRpYWxDYXRjaEJsb2NrcyA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgY3VyciA9IHRoaXM7XG4gICAgd2hpbGUgKGN1cnIudmIuaXNDYXRjaEJsb2NrKCkpIHtcbiAgICAgICAgY3VyciA9IGN1cnIucGFyZW47XG4gICAgfVxuICAgIHJldHVybiBjdXJyO1xufTtcblxuXG5leHBvcnRzLlZhckJsb2NrID0gVmFyQmxvY2s7XG5leHBvcnRzLmFubm90YXRlQmxvY2tJbmZvID0gYW5ub3RhdGVCbG9ja0luZm87XG5leHBvcnRzLlNjb3BlID0gU2NvcGU7XG4iLCJjb25zdCB3YWxrID0gcmVxdWlyZSgnYWNvcm4vZGlzdC93YWxrJyk7XG5jb25zdCBteVdhbGtlciA9IHJlcXVpcmUoJy4vdXRpbC9teVdhbGtlcicpO1xuXG5mdW5jdGlvbiBmaW5kSWRlbnRpZmllckF0KGFzdCwgcG9zKSB7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG5cbiAgICBmdW5jdGlvbiBGb3VuZChub2RlLCBzdGF0ZSkge1xuICAgICAgICB0aGlzLm5vZGUgPSBub2RlO1xuICAgICAgICB0aGlzLnN0YXRlID0gc3RhdGU7XG4gICAgfVxuXG4gICAgLy8gZmluZCB0aGUgbm9kZVxuICAgIGNvbnN0IHdhbGtlciA9IG15V2Fsa2VyLndyYXBXYWxrZXIobXlXYWxrZXIudmFyV2Fsa2VyLFxuICAgICAgICAobm9kZSwgdmIpID0+IHtcbiAgICAgICAgICAgIGlmIChub2RlLnN0YXJ0ID4gcG9zIHx8IG5vZGUuZW5kIDwgcG9zKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKG5vZGUudHlwZSA9PT0gJ0lkZW50aWZpZXInICYmIG5vZGUubmFtZSAhPT0gJ+KclicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRm91bmQobm9kZSwgdmIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgICAgd2Fsay5yZWN1cnNpdmUoYXN0LCBhc3RbJ0BibG9jayddLCB3YWxrZXIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBGb3VuZCkge1xuICAgICAgICAgICAgcmV0dXJuIGU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICB9XG4gICAgfVxuICAgIC8vIGlkZW50aWZpZXIgbm90IGZvdW5kXG4gICAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICpcbiAqIEBwYXJhbSBhc3QgLSBzY29wZSBhbm5vdGF0ZWQgQVNUXG4gKiBAcGFyYW0ge251bWJlcn0gcG9zIC0gY2hhcmFjdGVyIHBvc2l0aW9uXG4gKiBAcmV0dXJucyB7Kn0gLSBhcnJheSBvZiBBU1Qgbm9kZXNcbiAqL1xuZnVuY3Rpb24gZmluZFZhclJlZnNBdChhc3QsIHBvcykge1xuICAgIFwidXNlIHN0cmljdFwiO1xuICAgIGNvbnN0IGZvdW5kID0gZmluZElkZW50aWZpZXJBdChhc3QsIHBvcyk7XG4gICAgaWYgKCFmb3VuZCkge1xuICAgICAgICAvLyBwb3MgaXMgbm90IGF0IGEgdmFyaWFibGVcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIC8vIGZpbmQgcmVmcyBmb3IgdGhlIGlkIG5vZGVcbiAgICBjb25zdCByZWZzID0gZmluZFJlZnNUb1ZhcmlhYmxlKGFzdCwgZm91bmQpO1xuXG4gICAgcmV0dXJuIHJlZnM7XG59XG5cbi8qKlxuICpcbiAqIEBwYXJhbSBhc3QgLSBzY29wZSBhbm5vdGF0ZWQgQVNUXG4gKiBAcGFyYW0gZm91bmQgLSBub2RlIGFuZCB2YXJCbG9jayBvZiB0aGUgdmFyaWFibGVcbiAqIEByZXR1cm5zIHtBcnJheX0gLSBhcnJheSBvZiBBU1Qgbm9kZXNcbiAqL1xuZnVuY3Rpb24gZmluZFJlZnNUb1ZhcmlhYmxlKGFzdCwgZm91bmQpIHtcbiAgICBcInVzZSBzdHJpY3RcIjtcbiAgICBjb25zdCB2YXJOYW1lID0gZm91bmQubm9kZS5uYW1lO1xuICAgIGNvbnN0IHZiMSA9IGZvdW5kLnN0YXRlLmZpbmRWYXJJbkNoYWluKHZhck5hbWUpO1xuICAgIGNvbnN0IHJlZnMgPSBbXTtcblxuICAgIGNvbnN0IHdhbGtlciA9IHdhbGsubWFrZSh7XG4gICAgICAgIElkZW50aWZpZXI6IChub2RlLCB2YikgPT4ge1xuICAgICAgICAgICAgaWYgKG5vZGUubmFtZSAhPT0gdmFyTmFtZSkgcmV0dXJuO1xuICAgICAgICAgICAgaWYgKHZiMSA9PT0gdmIuZmluZFZhckluQ2hhaW4odmFyTmFtZSkpIHtcbiAgICAgICAgICAgICAgICByZWZzLnB1c2gobm9kZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9LCBteVdhbGtlci52YXJXYWxrZXIpO1xuXG4gICAgd2Fsay5yZWN1cnNpdmUodmIxLm9yaWdpbk5vZGUsIHZiMSwgd2Fsa2VyKTtcbiAgICByZXR1cm4gcmVmcztcbn1cblxuZXhwb3J0cy5maW5kSWRlbnRpZmllckF0ID0gZmluZElkZW50aWZpZXJBdDtcbmV4cG9ydHMuZmluZFZhclJlZnNBdCA9IGZpbmRWYXJSZWZzQXQ7IiwiKGZ1bmN0aW9uKGYpe2lmKHR5cGVvZiBleHBvcnRzPT09XCJvYmplY3RcIiYmdHlwZW9mIG1vZHVsZSE9PVwidW5kZWZpbmVkXCIpe21vZHVsZS5leHBvcnRzPWYoKX1lbHNlIGlmKHR5cGVvZiBkZWZpbmU9PT1cImZ1bmN0aW9uXCImJmRlZmluZS5hbWQpe2RlZmluZShbXSxmKX1lbHNle3ZhciBnO2lmKHR5cGVvZiB3aW5kb3chPT1cInVuZGVmaW5lZFwiKXtnPXdpbmRvd31lbHNlIGlmKHR5cGVvZiBnbG9iYWwhPT1cInVuZGVmaW5lZFwiKXtnPWdsb2JhbH1lbHNlIGlmKHR5cGVvZiBzZWxmIT09XCJ1bmRlZmluZWRcIil7Zz1zZWxmfWVsc2V7Zz10aGlzfWcuYWNvcm4gPSBmKCl9fSkoZnVuY3Rpb24oKXt2YXIgZGVmaW5lLG1vZHVsZSxleHBvcnRzO3JldHVybiAoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSh7MTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG4vLyBBIHJlY3Vyc2l2ZSBkZXNjZW50IHBhcnNlciBvcGVyYXRlcyBieSBkZWZpbmluZyBmdW5jdGlvbnMgZm9yIGFsbFxuLy8gc3ludGFjdGljIGVsZW1lbnRzLCBhbmQgcmVjdXJzaXZlbHkgY2FsbGluZyB0aG9zZSwgZWFjaCBmdW5jdGlvblxuLy8gYWR2YW5jaW5nIHRoZSBpbnB1dCBzdHJlYW0gYW5kIHJldHVybmluZyBhbiBBU1Qgbm9kZS4gUHJlY2VkZW5jZVxuLy8gb2YgY29uc3RydWN0cyAoZm9yIGV4YW1wbGUsIHRoZSBmYWN0IHRoYXQgYCF4WzFdYCBtZWFucyBgISh4WzFdKWBcbi8vIGluc3RlYWQgb2YgYCgheClbMV1gIGlzIGhhbmRsZWQgYnkgdGhlIGZhY3QgdGhhdCB0aGUgcGFyc2VyXG4vLyBmdW5jdGlvbiB0aGF0IHBhcnNlcyB1bmFyeSBwcmVmaXggb3BlcmF0b3JzIGlzIGNhbGxlZCBmaXJzdCwgYW5kXG4vLyBpbiB0dXJuIGNhbGxzIHRoZSBmdW5jdGlvbiB0aGF0IHBhcnNlcyBgW11gIHN1YnNjcmlwdHMg4oCUIHRoYXRcbi8vIHdheSwgaXQnbGwgcmVjZWl2ZSB0aGUgbm9kZSBmb3IgYHhbMV1gIGFscmVhZHkgcGFyc2VkLCBhbmQgd3JhcHNcbi8vICp0aGF0KiBpbiB0aGUgdW5hcnkgb3BlcmF0b3Igbm9kZS5cbi8vXG4vLyBBY29ybiB1c2VzIGFuIFtvcGVyYXRvciBwcmVjZWRlbmNlIHBhcnNlcl1bb3BwXSB0byBoYW5kbGUgYmluYXJ5XG4vLyBvcGVyYXRvciBwcmVjZWRlbmNlLCBiZWNhdXNlIGl0IGlzIG11Y2ggbW9yZSBjb21wYWN0IHRoYW4gdXNpbmdcbi8vIHRoZSB0ZWNobmlxdWUgb3V0bGluZWQgYWJvdmUsIHdoaWNoIHVzZXMgZGlmZmVyZW50LCBuZXN0aW5nXG4vLyBmdW5jdGlvbnMgdG8gc3BlY2lmeSBwcmVjZWRlbmNlLCBmb3IgYWxsIG9mIHRoZSB0ZW4gYmluYXJ5XG4vLyBwcmVjZWRlbmNlIGxldmVscyB0aGF0IEphdmFTY3JpcHQgZGVmaW5lcy5cbi8vXG4vLyBbb3BwXTogaHR0cDovL2VuLndpa2lwZWRpYS5vcmcvd2lraS9PcGVyYXRvci1wcmVjZWRlbmNlX3BhcnNlclxuXG5cInVzZSBzdHJpY3RcIjtcblxudmFyIF90b2tlbnR5cGUgPSBfZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF9pZGVudGlmaWVyID0gX2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTtcblxudmFyIF91dGlsID0gX2RlcmVxXyhcIi4vdXRpbFwiKTtcblxudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbi8vIENoZWNrIGlmIHByb3BlcnR5IG5hbWUgY2xhc2hlcyB3aXRoIGFscmVhZHkgYWRkZWQuXG4vLyBPYmplY3QvY2xhc3MgZ2V0dGVycyBhbmQgc2V0dGVycyBhcmUgbm90IGFsbG93ZWQgdG8gY2xhc2gg4oCUXG4vLyBlaXRoZXIgd2l0aCBlYWNoIG90aGVyIG9yIHdpdGggYW4gaW5pdCBwcm9wZXJ0eSDigJQgYW5kIGluXG4vLyBzdHJpY3QgbW9kZSwgaW5pdCBwcm9wZXJ0aWVzIGFyZSBhbHNvIG5vdCBhbGxvd2VkIHRvIGJlIHJlcGVhdGVkLlxuXG5wcC5jaGVja1Byb3BDbGFzaCA9IGZ1bmN0aW9uIChwcm9wLCBwcm9wSGFzaCkge1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgKHByb3AuY29tcHV0ZWQgfHwgcHJvcC5tZXRob2QgfHwgcHJvcC5zaG9ydGhhbmQpKSByZXR1cm47XG4gIHZhciBrZXkgPSBwcm9wLmtleSxcbiAgICAgIG5hbWUgPSB1bmRlZmluZWQ7XG4gIHN3aXRjaCAoa2V5LnR5cGUpIHtcbiAgICBjYXNlIFwiSWRlbnRpZmllclwiOlxuICAgICAgbmFtZSA9IGtleS5uYW1lO2JyZWFrO1xuICAgIGNhc2UgXCJMaXRlcmFsXCI6XG4gICAgICBuYW1lID0gU3RyaW5nKGtleS52YWx1ZSk7YnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybjtcbiAgfVxuICB2YXIga2luZCA9IHByb3Aua2luZDtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgaWYgKG5hbWUgPT09IFwiX19wcm90b19fXCIgJiYga2luZCA9PT0gXCJpbml0XCIpIHtcbiAgICAgIGlmIChwcm9wSGFzaC5wcm90bykgdGhpcy5yYWlzZShrZXkuc3RhcnQsIFwiUmVkZWZpbml0aW9uIG9mIF9fcHJvdG9fXyBwcm9wZXJ0eVwiKTtcbiAgICAgIHByb3BIYXNoLnByb3RvID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIHZhciBvdGhlciA9IHVuZGVmaW5lZDtcbiAgaWYgKF91dGlsLmhhcyhwcm9wSGFzaCwgbmFtZSkpIHtcbiAgICBvdGhlciA9IHByb3BIYXNoW25hbWVdO1xuICAgIHZhciBpc0dldFNldCA9IGtpbmQgIT09IFwiaW5pdFwiO1xuICAgIGlmICgodGhpcy5zdHJpY3QgfHwgaXNHZXRTZXQpICYmIG90aGVyW2tpbmRdIHx8ICEoaXNHZXRTZXQgXiBvdGhlci5pbml0KSkgdGhpcy5yYWlzZShrZXkuc3RhcnQsIFwiUmVkZWZpbml0aW9uIG9mIHByb3BlcnR5XCIpO1xuICB9IGVsc2Uge1xuICAgIG90aGVyID0gcHJvcEhhc2hbbmFtZV0gPSB7XG4gICAgICBpbml0OiBmYWxzZSxcbiAgICAgIGdldDogZmFsc2UsXG4gICAgICBzZXQ6IGZhbHNlXG4gICAgfTtcbiAgfVxuICBvdGhlcltraW5kXSA9IHRydWU7XG59O1xuXG4vLyAjIyMgRXhwcmVzc2lvbiBwYXJzaW5nXG5cbi8vIFRoZXNlIG5lc3QsIGZyb20gdGhlIG1vc3QgZ2VuZXJhbCBleHByZXNzaW9uIHR5cGUgYXQgdGhlIHRvcCB0b1xuLy8gJ2F0b21pYycsIG5vbmRpdmlzaWJsZSBleHByZXNzaW9uIHR5cGVzIGF0IHRoZSBib3R0b20uIE1vc3Qgb2Zcbi8vIHRoZSBmdW5jdGlvbnMgd2lsbCBzaW1wbHkgbGV0IHRoZSBmdW5jdGlvbihzKSBiZWxvdyB0aGVtIHBhcnNlLFxuLy8gYW5kLCAqaWYqIHRoZSBzeW50YWN0aWMgY29uc3RydWN0IHRoZXkgaGFuZGxlIGlzIHByZXNlbnQsIHdyYXBcbi8vIHRoZSBBU1Qgbm9kZSB0aGF0IHRoZSBpbm5lciBwYXJzZXIgZ2F2ZSB0aGVtIGluIGFub3RoZXIgbm9kZS5cblxuLy8gUGFyc2UgYSBmdWxsIGV4cHJlc3Npb24uIFRoZSBvcHRpb25hbCBhcmd1bWVudHMgYXJlIHVzZWQgdG9cbi8vIGZvcmJpZCB0aGUgYGluYCBvcGVyYXRvciAoaW4gZm9yIGxvb3BzIGluaXRhbGl6YXRpb24gZXhwcmVzc2lvbnMpXG4vLyBhbmQgcHJvdmlkZSByZWZlcmVuY2UgZm9yIHN0b3JpbmcgJz0nIG9wZXJhdG9yIGluc2lkZSBzaG9ydGhhbmRcbi8vIHByb3BlcnR5IGFzc2lnbm1lbnQgaW4gY29udGV4dHMgd2hlcmUgYm90aCBvYmplY3QgZXhwcmVzc2lvblxuLy8gYW5kIG9iamVjdCBwYXR0ZXJuIG1pZ2h0IGFwcGVhciAoc28gaXQncyBwb3NzaWJsZSB0byByYWlzZVxuLy8gZGVsYXllZCBzeW50YXggZXJyb3IgYXQgY29ycmVjdCBwb3NpdGlvbikuXG5cbnBwLnBhcnNlRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub0luLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gIHZhciBleHByID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4sIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmNvbW1hKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLCBzdGFydExvYyk7XG4gICAgbm9kZS5leHByZXNzaW9ucyA9IFtleHByXTtcbiAgICB3aGlsZSAodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb21tYSkpIG5vZGUuZXhwcmVzc2lvbnMucHVzaCh0aGlzLnBhcnNlTWF5YmVBc3NpZ24obm9JbiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJTZXF1ZW5jZUV4cHJlc3Npb25cIik7XG4gIH1cbiAgcmV0dXJuIGV4cHI7XG59O1xuXG4vLyBQYXJzZSBhbiBhc3NpZ25tZW50IGV4cHJlc3Npb24uIFRoaXMgaW5jbHVkZXMgYXBwbGljYXRpb25zIG9mXG4vLyBvcGVyYXRvcnMgbGlrZSBgKz1gLlxuXG5wcC5wYXJzZU1heWJlQXNzaWduID0gZnVuY3Rpb24gKG5vSW4sIHJlZlNob3J0aGFuZERlZmF1bHRQb3MsIGFmdGVyTGVmdFBhcnNlKSB7XG4gIGlmICh0aGlzLnR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5feWllbGQgJiYgdGhpcy5pbkdlbmVyYXRvcikgcmV0dXJuIHRoaXMucGFyc2VZaWVsZCgpO1xuXG4gIHZhciBmYWlsT25TaG9ydGhhbmRBc3NpZ24gPSB1bmRlZmluZWQ7XG4gIGlmICghcmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICAgIHJlZlNob3J0aGFuZERlZmF1bHRQb3MgPSB7IHN0YXJ0OiAwIH07XG4gICAgZmFpbE9uU2hvcnRoYW5kQXNzaWduID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICBmYWlsT25TaG9ydGhhbmRBc3NpZ24gPSBmYWxzZTtcbiAgfVxuICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICBpZiAodGhpcy50eXBlID09IF90b2tlbnR5cGUudHlwZXMucGFyZW5MIHx8IHRoaXMudHlwZSA9PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpIHRoaXMucG90ZW50aWFsQXJyb3dBdCA9IHRoaXMuc3RhcnQ7XG4gIHZhciBsZWZ0ID0gdGhpcy5wYXJzZU1heWJlQ29uZGl0aW9uYWwobm9JbiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gIGlmIChhZnRlckxlZnRQYXJzZSkgbGVmdCA9IGFmdGVyTGVmdFBhcnNlLmNhbGwodGhpcywgbGVmdCwgc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgaWYgKHRoaXMudHlwZS5pc0Fzc2lnbikge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgIG5vZGUub3BlcmF0b3IgPSB0aGlzLnZhbHVlO1xuICAgIG5vZGUubGVmdCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lcSA/IHRoaXMudG9Bc3NpZ25hYmxlKGxlZnQpIDogbGVmdDtcbiAgICByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0ID0gMDsgLy8gcmVzZXQgYmVjYXVzZSBzaG9ydGhhbmQgZGVmYXVsdCB3YXMgdXNlZCBjb3JyZWN0bHlcbiAgICB0aGlzLmNoZWNrTFZhbChsZWZ0KTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICBub2RlLnJpZ2h0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4pO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJBc3NpZ25tZW50RXhwcmVzc2lvblwiKTtcbiAgfSBlbHNlIGlmIChmYWlsT25TaG9ydGhhbmRBc3NpZ24gJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCkge1xuICAgIHRoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTtcbiAgfVxuICByZXR1cm4gbGVmdDtcbn07XG5cbi8vIFBhcnNlIGEgdGVybmFyeSBjb25kaXRpb25hbCAoYD86YCkgb3BlcmF0b3IuXG5cbnBwLnBhcnNlTWF5YmVDb25kaXRpb25hbCA9IGZ1bmN0aW9uIChub0luLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gIHZhciBleHByID0gdGhpcy5wYXJzZUV4cHJPcHMobm9JbiwgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gIGlmIChyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHJldHVybiBleHByO1xuICBpZiAodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5xdWVzdGlvbikpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgICBub2RlLnRlc3QgPSBleHByO1xuICAgIG5vZGUuY29uc2VxdWVudCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29sb24pO1xuICAgIG5vZGUuYWx0ZXJuYXRlID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4pO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJDb25kaXRpb25hbEV4cHJlc3Npb25cIik7XG4gIH1cbiAgcmV0dXJuIGV4cHI7XG59O1xuXG4vLyBTdGFydCB0aGUgcHJlY2VkZW5jZSBwYXJzZXIuXG5cbnBwLnBhcnNlRXhwck9wcyA9IGZ1bmN0aW9uIChub0luLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gIHZhciBleHByID0gdGhpcy5wYXJzZU1heWJlVW5hcnkocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gIGlmIChyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHJldHVybiBleHByO1xuICByZXR1cm4gdGhpcy5wYXJzZUV4cHJPcChleHByLCBzdGFydFBvcywgc3RhcnRMb2MsIC0xLCBub0luKTtcbn07XG5cbi8vIFBhcnNlIGJpbmFyeSBvcGVyYXRvcnMgd2l0aCB0aGUgb3BlcmF0b3IgcHJlY2VkZW5jZSBwYXJzaW5nXG4vLyBhbGdvcml0aG0uIGBsZWZ0YCBpcyB0aGUgbGVmdC1oYW5kIHNpZGUgb2YgdGhlIG9wZXJhdG9yLlxuLy8gYG1pblByZWNgIHByb3ZpZGVzIGNvbnRleHQgdGhhdCBhbGxvd3MgdGhlIGZ1bmN0aW9uIHRvIHN0b3AgYW5kXG4vLyBkZWZlciBmdXJ0aGVyIHBhcnNlciB0byBvbmUgb2YgaXRzIGNhbGxlcnMgd2hlbiBpdCBlbmNvdW50ZXJzIGFuXG4vLyBvcGVyYXRvciB0aGF0IGhhcyBhIGxvd2VyIHByZWNlZGVuY2UgdGhhbiB0aGUgc2V0IGl0IGlzIHBhcnNpbmcuXG5cbnBwLnBhcnNlRXhwck9wID0gZnVuY3Rpb24gKGxlZnQsIGxlZnRTdGFydFBvcywgbGVmdFN0YXJ0TG9jLCBtaW5QcmVjLCBub0luKSB7XG4gIHZhciBwcmVjID0gdGhpcy50eXBlLmJpbm9wO1xuICBpZiAocHJlYyAhPSBudWxsICYmICghbm9JbiB8fCB0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMuX2luKSkge1xuICAgIGlmIChwcmVjID4gbWluUHJlYykge1xuICAgICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KGxlZnRTdGFydFBvcywgbGVmdFN0YXJ0TG9jKTtcbiAgICAgIG5vZGUubGVmdCA9IGxlZnQ7XG4gICAgICBub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTtcbiAgICAgIHZhciBvcCA9IHRoaXMudHlwZTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgdmFyIHN0YXJ0UG9zID0gdGhpcy5zdGFydCxcbiAgICAgICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gICAgICBub2RlLnJpZ2h0ID0gdGhpcy5wYXJzZUV4cHJPcCh0aGlzLnBhcnNlTWF5YmVVbmFyeSgpLCBzdGFydFBvcywgc3RhcnRMb2MsIHByZWMsIG5vSW4pO1xuICAgICAgdGhpcy5maW5pc2hOb2RlKG5vZGUsIG9wID09PSBfdG9rZW50eXBlLnR5cGVzLmxvZ2ljYWxPUiB8fCBvcCA9PT0gX3Rva2VudHlwZS50eXBlcy5sb2dpY2FsQU5EID8gXCJMb2dpY2FsRXhwcmVzc2lvblwiIDogXCJCaW5hcnlFeHByZXNzaW9uXCIpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VFeHByT3Aobm9kZSwgbGVmdFN0YXJ0UG9zLCBsZWZ0U3RhcnRMb2MsIG1pblByZWMsIG5vSW4pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbGVmdDtcbn07XG5cbi8vIFBhcnNlIHVuYXJ5IG9wZXJhdG9ycywgYm90aCBwcmVmaXggYW5kIHBvc3RmaXguXG5cbnBwLnBhcnNlTWF5YmVVbmFyeSA9IGZ1bmN0aW9uIChyZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIGlmICh0aGlzLnR5cGUucHJlZml4KSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpLFxuICAgICAgICB1cGRhdGUgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuaW5jRGVjO1xuICAgIG5vZGUub3BlcmF0b3IgPSB0aGlzLnZhbHVlO1xuICAgIG5vZGUucHJlZml4ID0gdHJ1ZTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlVW5hcnkoKTtcbiAgICBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KSB0aGlzLnVuZXhwZWN0ZWQocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCk7XG4gICAgaWYgKHVwZGF0ZSkgdGhpcy5jaGVja0xWYWwobm9kZS5hcmd1bWVudCk7ZWxzZSBpZiAodGhpcy5zdHJpY3QgJiYgbm9kZS5vcGVyYXRvciA9PT0gXCJkZWxldGVcIiAmJiBub2RlLmFyZ3VtZW50LnR5cGUgPT09IFwiSWRlbnRpZmllclwiKSB0aGlzLnJhaXNlKG5vZGUuc3RhcnQsIFwiRGVsZXRpbmcgbG9jYWwgdmFyaWFibGUgaW4gc3RyaWN0IG1vZGVcIik7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCB1cGRhdGUgPyBcIlVwZGF0ZUV4cHJlc3Npb25cIiA6IFwiVW5hcnlFeHByZXNzaW9uXCIpO1xuICB9XG4gIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gIHZhciBleHByID0gdGhpcy5wYXJzZUV4cHJTdWJzY3JpcHRzKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KSByZXR1cm4gZXhwcjtcbiAgd2hpbGUgKHRoaXMudHlwZS5wb3N0Zml4ICYmICF0aGlzLmNhbkluc2VydFNlbWljb2xvbigpKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLCBzdGFydExvYyk7XG4gICAgbm9kZS5vcGVyYXRvciA9IHRoaXMudmFsdWU7XG4gICAgbm9kZS5wcmVmaXggPSBmYWxzZTtcbiAgICBub2RlLmFyZ3VtZW50ID0gZXhwcjtcbiAgICB0aGlzLmNoZWNrTFZhbChleHByKTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICBleHByID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVXBkYXRlRXhwcmVzc2lvblwiKTtcbiAgfVxuICByZXR1cm4gZXhwcjtcbn07XG5cbi8vIFBhcnNlIGNhbGwsIGRvdCwgYW5kIGBbXWAtc3Vic2NyaXB0IGV4cHJlc3Npb25zLlxuXG5wcC5wYXJzZUV4cHJTdWJzY3JpcHRzID0gZnVuY3Rpb24gKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpIHtcbiAgdmFyIHN0YXJ0UG9zID0gdGhpcy5zdGFydCxcbiAgICAgIHN0YXJ0TG9jID0gdGhpcy5zdGFydExvYztcbiAgdmFyIGV4cHIgPSB0aGlzLnBhcnNlRXhwckF0b20ocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gIGlmIChyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpIHJldHVybiBleHByO1xuICByZXR1cm4gdGhpcy5wYXJzZVN1YnNjcmlwdHMoZXhwciwgc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbn07XG5cbnBwLnBhcnNlU3Vic2NyaXB0cyA9IGZ1bmN0aW9uIChiYXNlLCBzdGFydFBvcywgc3RhcnRMb2MsIG5vQ2FsbHMpIHtcbiAgZm9yICg7Oykge1xuICAgIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmRvdCkpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgICAgbm9kZS5vYmplY3QgPSBiYXNlO1xuICAgICAgbm9kZS5wcm9wZXJ0eSA9IHRoaXMucGFyc2VJZGVudCh0cnVlKTtcbiAgICAgIG5vZGUuY29tcHV0ZWQgPSBmYWxzZTtcbiAgICAgIGJhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJNZW1iZXJFeHByZXNzaW9uXCIpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFja2V0TCkpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgICAgbm9kZS5vYmplY3QgPSBiYXNlO1xuICAgICAgbm9kZS5wcm9wZXJ0eSA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gICAgICBub2RlLmNvbXB1dGVkID0gdHJ1ZTtcbiAgICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldFIpO1xuICAgICAgYmFzZSA9IHRoaXMuZmluaXNoTm9kZShub2RlLCBcIk1lbWJlckV4cHJlc3Npb25cIik7XG4gICAgfSBlbHNlIGlmICghbm9DYWxscyAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCkpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgICAgbm9kZS5jYWxsZWUgPSBiYXNlO1xuICAgICAgbm9kZS5hcmd1bWVudHMgPSB0aGlzLnBhcnNlRXhwckxpc3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIsIGZhbHNlKTtcbiAgICAgIGJhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJDYWxsRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGUpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgICAgbm9kZS50YWcgPSBiYXNlO1xuICAgICAgbm9kZS5xdWFzaSA9IHRoaXMucGFyc2VUZW1wbGF0ZSgpO1xuICAgICAgYmFzZSA9IHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRhZ2dlZFRlbXBsYXRlRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGJhc2U7XG4gICAgfVxuICB9XG59O1xuXG4vLyBQYXJzZSBhbiBhdG9taWMgZXhwcmVzc2lvbiDigJQgZWl0aGVyIGEgc2luZ2xlIHRva2VuIHRoYXQgaXMgYW5cbi8vIGV4cHJlc3Npb24sIGFuIGV4cHJlc3Npb24gc3RhcnRlZCBieSBhIGtleXdvcmQgbGlrZSBgZnVuY3Rpb25gIG9yXG4vLyBgbmV3YCwgb3IgYW4gZXhwcmVzc2lvbiB3cmFwcGVkIGluIHB1bmN0dWF0aW9uIGxpa2UgYCgpYCwgYFtdYCxcbi8vIG9yIGB7fWAuXG5cbnBwLnBhcnNlRXhwckF0b20gPSBmdW5jdGlvbiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcykge1xuICB2YXIgbm9kZSA9IHVuZGVmaW5lZCxcbiAgICAgIGNhbkJlQXJyb3cgPSB0aGlzLnBvdGVudGlhbEFycm93QXQgPT0gdGhpcy5zdGFydDtcbiAgc3dpdGNoICh0aGlzLnR5cGUpIHtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3N1cGVyOlxuICAgICAgaWYgKCF0aGlzLmluRnVuY3Rpb24pIHRoaXMucmFpc2UodGhpcy5zdGFydCwgXCInc3VwZXInIG91dHNpZGUgb2YgZnVuY3Rpb24gb3IgY2xhc3NcIik7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl90aGlzOlxuICAgICAgdmFyIHR5cGUgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3RoaXMgPyBcIlRoaXNFeHByZXNzaW9uXCIgOiBcIlN1cGVyXCI7XG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCB0eXBlKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5feWllbGQ6XG4gICAgICBpZiAodGhpcy5pbkdlbmVyYXRvcikgdGhpcy51bmV4cGVjdGVkKCk7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMubmFtZTpcbiAgICAgIHZhciBzdGFydFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICAgICAgdmFyIGlkID0gdGhpcy5wYXJzZUlkZW50KHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKTtcbiAgICAgIGlmIChjYW5CZUFycm93ICYmICF0aGlzLmNhbkluc2VydFNlbWljb2xvbigpICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYXJyb3cpKSByZXR1cm4gdGhpcy5wYXJzZUFycm93RXhwcmVzc2lvbih0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLCBzdGFydExvYyksIFtpZF0pO1xuICAgICAgcmV0dXJuIGlkO1xuXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLnJlZ2V4cDpcbiAgICAgIHZhciB2YWx1ZSA9IHRoaXMudmFsdWU7XG4gICAgICBub2RlID0gdGhpcy5wYXJzZUxpdGVyYWwodmFsdWUudmFsdWUpO1xuICAgICAgbm9kZS5yZWdleCA9IHsgcGF0dGVybjogdmFsdWUucGF0dGVybiwgZmxhZ3M6IHZhbHVlLmZsYWdzIH07XG4gICAgICByZXR1cm4gbm9kZTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5udW06Y2FzZSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZzpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlTGl0ZXJhbCh0aGlzLnZhbHVlKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fbnVsbDpjYXNlIF90b2tlbnR5cGUudHlwZXMuX3RydWU6Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9mYWxzZTpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgbm9kZS52YWx1ZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fbnVsbCA/IG51bGwgOiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3RydWU7XG4gICAgICBub2RlLnJhdyA9IHRoaXMudHlwZS5rZXl3b3JkO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTGl0ZXJhbFwiKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5wYXJlbkw6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVBhcmVuQW5kRGlzdGluZ3Vpc2hFeHByZXNzaW9uKGNhbkJlQXJyb3cpO1xuXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRMOlxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIC8vIGNoZWNrIHdoZXRoZXIgdGhpcyBpcyBhcnJheSBjb21wcmVoZW5zaW9uIG9yIHJlZ3VsYXIgYXJyYXlcbiAgICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNyAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Zvcikge1xuICAgICAgICByZXR1cm4gdGhpcy5wYXJzZUNvbXByZWhlbnNpb24obm9kZSwgZmFsc2UpO1xuICAgICAgfVxuICAgICAgbm9kZS5lbGVtZW50cyA9IHRoaXMucGFyc2VFeHByTGlzdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSLCB0cnVlLCB0cnVlLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJBcnJheUV4cHJlc3Npb25cIik7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2VMOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VPYmooZmFsc2UsIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9mdW5jdGlvbjpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUZ1bmN0aW9uKG5vZGUsIGZhbHNlKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fY2xhc3M6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUNsYXNzKHRoaXMuc3RhcnROb2RlKCksIGZhbHNlKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fbmV3OlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VOZXcoKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGU6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVRlbXBsYXRlKCk7XG5cbiAgICBkZWZhdWx0OlxuICAgICAgdGhpcy51bmV4cGVjdGVkKCk7XG4gIH1cbn07XG5cbnBwLnBhcnNlTGl0ZXJhbCA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIG5vZGUudmFsdWUgPSB2YWx1ZTtcbiAgbm9kZS5yYXcgPSB0aGlzLmlucHV0LnNsaWNlKHRoaXMuc3RhcnQsIHRoaXMuZW5kKTtcbiAgdGhpcy5uZXh0KCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJMaXRlcmFsXCIpO1xufTtcblxucHAucGFyc2VQYXJlbkV4cHJlc3Npb24gPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtcbiAgdmFyIHZhbCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtcbiAgcmV0dXJuIHZhbDtcbn07XG5cbnBwLnBhcnNlUGFyZW5BbmREaXN0aW5ndWlzaEV4cHJlc3Npb24gPSBmdW5jdGlvbiAoY2FuQmVBcnJvdykge1xuICB2YXIgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgc3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jLFxuICAgICAgdmFsID0gdW5kZWZpbmVkO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICB0aGlzLm5leHQoKTtcblxuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNyAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Zvcikge1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VDb21wcmVoZW5zaW9uKHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgdmFyIGlubmVyU3RhcnRQb3MgPSB0aGlzLnN0YXJ0LFxuICAgICAgICBpbm5lclN0YXJ0TG9jID0gdGhpcy5zdGFydExvYztcbiAgICB2YXIgZXhwckxpc3QgPSBbXSxcbiAgICAgICAgZmlyc3QgPSB0cnVlO1xuICAgIHZhciByZWZTaG9ydGhhbmREZWZhdWx0UG9zID0geyBzdGFydDogMCB9LFxuICAgICAgICBzcHJlYWRTdGFydCA9IHVuZGVmaW5lZCxcbiAgICAgICAgaW5uZXJQYXJlblN0YXJ0ID0gdW5kZWZpbmVkO1xuICAgIHdoaWxlICh0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5SKSB7XG4gICAgICBmaXJzdCA/IGZpcnN0ID0gZmFsc2UgOiB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtcbiAgICAgIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpIHtcbiAgICAgICAgc3ByZWFkU3RhcnQgPSB0aGlzLnN0YXJ0O1xuICAgICAgICBleHByTGlzdC5wdXNoKHRoaXMucGFyc2VQYXJlbkl0ZW0odGhpcy5wYXJzZVJlc3QoKSkpO1xuICAgICAgICBicmVhaztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5MICYmICFpbm5lclBhcmVuU3RhcnQpIHtcbiAgICAgICAgICBpbm5lclBhcmVuU3RhcnQgPSB0aGlzLnN0YXJ0O1xuICAgICAgICB9XG4gICAgICAgIGV4cHJMaXN0LnB1c2godGhpcy5wYXJzZU1heWJlQXNzaWduKGZhbHNlLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zLCB0aGlzLnBhcnNlUGFyZW5JdGVtKSk7XG4gICAgICB9XG4gICAgfVxuICAgIHZhciBpbm5lckVuZFBvcyA9IHRoaXMuc3RhcnQsXG4gICAgICAgIGlubmVyRW5kTG9jID0gdGhpcy5zdGFydExvYztcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7XG5cbiAgICBpZiAoY2FuQmVBcnJvdyAmJiAhdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmFycm93KSkge1xuICAgICAgaWYgKGlubmVyUGFyZW5TdGFydCkgdGhpcy51bmV4cGVjdGVkKGlubmVyUGFyZW5TdGFydCk7XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVBhcmVuQXJyb3dMaXN0KHN0YXJ0UG9zLCBzdGFydExvYywgZXhwckxpc3QpO1xuICAgIH1cblxuICAgIGlmICghZXhwckxpc3QubGVuZ3RoKSB0aGlzLnVuZXhwZWN0ZWQodGhpcy5sYXN0VG9rU3RhcnQpO1xuICAgIGlmIChzcHJlYWRTdGFydCkgdGhpcy51bmV4cGVjdGVkKHNwcmVhZFN0YXJ0KTtcbiAgICBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCkgdGhpcy51bmV4cGVjdGVkKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpO1xuXG4gICAgaWYgKGV4cHJMaXN0Lmxlbmd0aCA+IDEpIHtcbiAgICAgIHZhbCA9IHRoaXMuc3RhcnROb2RlQXQoaW5uZXJTdGFydFBvcywgaW5uZXJTdGFydExvYyk7XG4gICAgICB2YWwuZXhwcmVzc2lvbnMgPSBleHByTGlzdDtcbiAgICAgIHRoaXMuZmluaXNoTm9kZUF0KHZhbCwgXCJTZXF1ZW5jZUV4cHJlc3Npb25cIiwgaW5uZXJFbmRQb3MsIGlubmVyRW5kTG9jKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFsID0gZXhwckxpc3RbMF07XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHZhbCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtcbiAgfVxuXG4gIGlmICh0aGlzLm9wdGlvbnMucHJlc2VydmVQYXJlbnMpIHtcbiAgICB2YXIgcGFyID0gdGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpO1xuICAgIHBhci5leHByZXNzaW9uID0gdmFsO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUocGFyLCBcIlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uXCIpO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiB2YWw7XG4gIH1cbn07XG5cbnBwLnBhcnNlUGFyZW5JdGVtID0gZnVuY3Rpb24gKGl0ZW0pIHtcbiAgcmV0dXJuIGl0ZW07XG59O1xuXG5wcC5wYXJzZVBhcmVuQXJyb3dMaXN0ID0gZnVuY3Rpb24gKHN0YXJ0UG9zLCBzdGFydExvYywgZXhwckxpc3QpIHtcbiAgcmV0dXJuIHRoaXMucGFyc2VBcnJvd0V4cHJlc3Npb24odGhpcy5zdGFydE5vZGVBdChzdGFydFBvcywgc3RhcnRMb2MpLCBleHByTGlzdCk7XG59O1xuXG4vLyBOZXcncyBwcmVjZWRlbmNlIGlzIHNsaWdodGx5IHRyaWNreS4gSXQgbXVzdCBhbGxvdyBpdHMgYXJndW1lbnRcbi8vIHRvIGJlIGEgYFtdYCBvciBkb3Qgc3Vic2NyaXB0IGV4cHJlc3Npb24sIGJ1dCBub3QgYSBjYWxsIOKAlCBhdFxuLy8gbGVhc3QsIG5vdCB3aXRob3V0IHdyYXBwaW5nIGl0IGluIHBhcmVudGhlc2VzLiBUaHVzLCBpdCB1c2VzIHRoZVxuXG52YXIgZW1wdHkgPSBbXTtcblxucHAucGFyc2VOZXcgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdmFyIG1ldGEgPSB0aGlzLnBhcnNlSWRlbnQodHJ1ZSk7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmRvdCkpIHtcbiAgICBub2RlLm1ldGEgPSBtZXRhO1xuICAgIG5vZGUucHJvcGVydHkgPSB0aGlzLnBhcnNlSWRlbnQodHJ1ZSk7XG4gICAgaWYgKG5vZGUucHJvcGVydHkubmFtZSAhPT0gXCJ0YXJnZXRcIikgdGhpcy5yYWlzZShub2RlLnByb3BlcnR5LnN0YXJ0LCBcIlRoZSBvbmx5IHZhbGlkIG1ldGEgcHJvcGVydHkgZm9yIG5ldyBpcyBuZXcudGFyZ2V0XCIpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJNZXRhUHJvcGVydHlcIik7XG4gIH1cbiAgdmFyIHN0YXJ0UG9zID0gdGhpcy5zdGFydCxcbiAgICAgIHN0YXJ0TG9jID0gdGhpcy5zdGFydExvYztcbiAgbm9kZS5jYWxsZWUgPSB0aGlzLnBhcnNlU3Vic2NyaXB0cyh0aGlzLnBhcnNlRXhwckF0b20oKSwgc3RhcnRQb3MsIHN0YXJ0TG9jLCB0cnVlKTtcbiAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKSkgbm9kZS5hcmd1bWVudHMgPSB0aGlzLnBhcnNlRXhwckxpc3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIsIGZhbHNlKTtlbHNlIG5vZGUuYXJndW1lbnRzID0gZW1wdHk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJOZXdFeHByZXNzaW9uXCIpO1xufTtcblxuLy8gUGFyc2UgdGVtcGxhdGUgZXhwcmVzc2lvbi5cblxucHAucGFyc2VUZW1wbGF0ZUVsZW1lbnQgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBlbGVtID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgZWxlbS52YWx1ZSA9IHtcbiAgICByYXc6IHRoaXMuaW5wdXQuc2xpY2UodGhpcy5zdGFydCwgdGhpcy5lbmQpLnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpLFxuICAgIGNvb2tlZDogdGhpcy52YWx1ZVxuICB9O1xuICB0aGlzLm5leHQoKTtcbiAgZWxlbS50YWlsID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShlbGVtLCBcIlRlbXBsYXRlRWxlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlVGVtcGxhdGUgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUuZXhwcmVzc2lvbnMgPSBbXTtcbiAgdmFyIGN1ckVsdCA9IHRoaXMucGFyc2VUZW1wbGF0ZUVsZW1lbnQoKTtcbiAgbm9kZS5xdWFzaXMgPSBbY3VyRWx0XTtcbiAgd2hpbGUgKCFjdXJFbHQudGFpbCkge1xuICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuZG9sbGFyQnJhY2VMKTtcbiAgICBub2RlLmV4cHJlc3Npb25zLnB1c2godGhpcy5wYXJzZUV4cHJlc3Npb24oKSk7XG4gICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpO1xuICAgIG5vZGUucXVhc2lzLnB1c2goY3VyRWx0ID0gdGhpcy5wYXJzZVRlbXBsYXRlRWxlbWVudCgpKTtcbiAgfVxuICB0aGlzLm5leHQoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRlbXBsYXRlTGl0ZXJhbFwiKTtcbn07XG5cbi8vIFBhcnNlIGFuIG9iamVjdCBsaXRlcmFsIG9yIGJpbmRpbmcgcGF0dGVybi5cblxucHAucGFyc2VPYmogPSBmdW5jdGlvbiAoaXNQYXR0ZXJuLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgIGZpcnN0ID0gdHJ1ZSxcbiAgICAgIHByb3BIYXNoID0ge307XG4gIG5vZGUucHJvcGVydGllcyA9IFtdO1xuICB0aGlzLm5leHQoKTtcbiAgd2hpbGUgKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtcbiAgICBpZiAoIWZpcnN0KSB7XG4gICAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtcbiAgICAgIGlmICh0aGlzLmFmdGVyVHJhaWxpbmdDb21tYShfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIGJyZWFrO1xuICAgIH0gZWxzZSBmaXJzdCA9IGZhbHNlO1xuXG4gICAgdmFyIHByb3AgPSB0aGlzLnN0YXJ0Tm9kZSgpLFxuICAgICAgICBpc0dlbmVyYXRvciA9IHVuZGVmaW5lZCxcbiAgICAgICAgc3RhcnRQb3MgPSB1bmRlZmluZWQsXG4gICAgICAgIHN0YXJ0TG9jID0gdW5kZWZpbmVkO1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgICAgcHJvcC5tZXRob2QgPSBmYWxzZTtcbiAgICAgIHByb3Auc2hvcnRoYW5kID0gZmFsc2U7XG4gICAgICBpZiAoaXNQYXR0ZXJuIHx8IHJlZlNob3J0aGFuZERlZmF1bHRQb3MpIHtcbiAgICAgICAgc3RhcnRQb3MgPSB0aGlzLnN0YXJ0O1xuICAgICAgICBzdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7XG4gICAgICB9XG4gICAgICBpZiAoIWlzUGF0dGVybikgaXNHZW5lcmF0b3IgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO1xuICAgIH1cbiAgICB0aGlzLnBhcnNlUHJvcGVydHlOYW1lKHByb3ApO1xuICAgIHRoaXMucGFyc2VQcm9wZXJ0eVZhbHVlKHByb3AsIGlzUGF0dGVybiwgaXNHZW5lcmF0b3IsIHN0YXJ0UG9zLCBzdGFydExvYywgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gICAgdGhpcy5jaGVja1Byb3BDbGFzaChwcm9wLCBwcm9wSGFzaCk7XG4gICAgbm9kZS5wcm9wZXJ0aWVzLnB1c2godGhpcy5maW5pc2hOb2RlKHByb3AsIFwiUHJvcGVydHlcIikpO1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgaXNQYXR0ZXJuID8gXCJPYmplY3RQYXR0ZXJuXCIgOiBcIk9iamVjdEV4cHJlc3Npb25cIik7XG59O1xuXG5wcC5wYXJzZVByb3BlcnR5VmFsdWUgPSBmdW5jdGlvbiAocHJvcCwgaXNQYXR0ZXJuLCBpc0dlbmVyYXRvciwgc3RhcnRQb3MsIHN0YXJ0TG9jLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIGlmICh0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmNvbG9uKSkge1xuICAgIHByb3AudmFsdWUgPSBpc1BhdHRlcm4gPyB0aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHRoaXMuc3RhcnQsIHRoaXMuc3RhcnRMb2MpIDogdGhpcy5wYXJzZU1heWJlQXNzaWduKGZhbHNlLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcbiAgICBwcm9wLmtpbmQgPSBcImluaXRcIjtcbiAgfSBlbHNlIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5MKSB7XG4gICAgaWYgKGlzUGF0dGVybikgdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgcHJvcC5raW5kID0gXCJpbml0XCI7XG4gICAgcHJvcC5tZXRob2QgPSB0cnVlO1xuICAgIHByb3AudmFsdWUgPSB0aGlzLnBhcnNlTWV0aG9kKGlzR2VuZXJhdG9yKTtcbiAgfSBlbHNlIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNSAmJiAhcHJvcC5jb21wdXRlZCAmJiBwcm9wLmtleS50eXBlID09PSBcIklkZW50aWZpZXJcIiAmJiAocHJvcC5rZXkubmFtZSA9PT0gXCJnZXRcIiB8fCBwcm9wLmtleS5uYW1lID09PSBcInNldFwiKSAmJiAodGhpcy50eXBlICE9IF90b2tlbnR5cGUudHlwZXMuY29tbWEgJiYgdGhpcy50eXBlICE9IF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge1xuICAgIGlmIChpc0dlbmVyYXRvciB8fCBpc1BhdHRlcm4pIHRoaXMudW5leHBlY3RlZCgpO1xuICAgIHByb3Aua2luZCA9IHByb3Aua2V5Lm5hbWU7XG4gICAgdGhpcy5wYXJzZVByb3BlcnR5TmFtZShwcm9wKTtcbiAgICBwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1ldGhvZChmYWxzZSk7XG4gICAgdmFyIHBhcmFtQ291bnQgPSBwcm9wLmtpbmQgPT09IFwiZ2V0XCIgPyAwIDogMTtcbiAgICBpZiAocHJvcC52YWx1ZS5wYXJhbXMubGVuZ3RoICE9PSBwYXJhbUNvdW50KSB7XG4gICAgICB2YXIgc3RhcnQgPSBwcm9wLnZhbHVlLnN0YXJ0O1xuICAgICAgaWYgKHByb3Aua2luZCA9PT0gXCJnZXRcIikgdGhpcy5yYWlzZShzdGFydCwgXCJnZXR0ZXIgc2hvdWxkIGhhdmUgbm8gcGFyYW1zXCIpO2Vsc2UgdGhpcy5yYWlzZShzdGFydCwgXCJzZXR0ZXIgc2hvdWxkIGhhdmUgZXhhY3RseSBvbmUgcGFyYW1cIik7XG4gICAgfVxuICB9IGVsc2UgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmICFwcm9wLmNvbXB1dGVkICYmIHByb3Aua2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiKSB7XG4gICAgcHJvcC5raW5kID0gXCJpbml0XCI7XG4gICAgaWYgKGlzUGF0dGVybikge1xuICAgICAgaWYgKHRoaXMuaXNLZXl3b3JkKHByb3Aua2V5Lm5hbWUpIHx8IHRoaXMuc3RyaWN0ICYmIChfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzLnN0cmljdEJpbmQocHJvcC5rZXkubmFtZSkgfHwgX2lkZW50aWZpZXIucmVzZXJ2ZWRXb3Jkcy5zdHJpY3QocHJvcC5rZXkubmFtZSkpIHx8ICF0aGlzLm9wdGlvbnMuYWxsb3dSZXNlcnZlZCAmJiB0aGlzLmlzUmVzZXJ2ZWRXb3JkKHByb3Aua2V5Lm5hbWUpKSB0aGlzLnJhaXNlKHByb3Aua2V5LnN0YXJ0LCBcIkJpbmRpbmcgXCIgKyBwcm9wLmtleS5uYW1lKTtcbiAgICAgIHByb3AudmFsdWUgPSB0aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHN0YXJ0UG9zLCBzdGFydExvYywgcHJvcC5rZXkpO1xuICAgIH0gZWxzZSBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVxICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpIHtcbiAgICAgIGlmICghcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCkgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCA9IHRoaXMuc3RhcnQ7XG4gICAgICBwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1heWJlRGVmYXVsdChzdGFydFBvcywgc3RhcnRMb2MsIHByb3Aua2V5KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvcC52YWx1ZSA9IHByb3Aua2V5O1xuICAgIH1cbiAgICBwcm9wLnNob3J0aGFuZCA9IHRydWU7XG4gIH0gZWxzZSB0aGlzLnVuZXhwZWN0ZWQoKTtcbn07XG5cbnBwLnBhcnNlUHJvcGVydHlOYW1lID0gZnVuY3Rpb24gKHByb3ApIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEwpKSB7XG4gICAgICBwcm9wLmNvbXB1dGVkID0gdHJ1ZTtcbiAgICAgIHByb3Aua2V5ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtcbiAgICAgIHJldHVybiBwcm9wLmtleTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvcC5jb21wdXRlZCA9IGZhbHNlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcHJvcC5rZXkgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubnVtIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcgPyB0aGlzLnBhcnNlRXhwckF0b20oKSA6IHRoaXMucGFyc2VJZGVudCh0cnVlKTtcbn07XG5cbi8vIEluaXRpYWxpemUgZW1wdHkgZnVuY3Rpb24gbm9kZS5cblxucHAuaW5pdEZ1bmN0aW9uID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgbm9kZS5pZCA9IG51bGw7XG4gIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIG5vZGUuZ2VuZXJhdG9yID0gZmFsc2U7XG4gICAgbm9kZS5leHByZXNzaW9uID0gZmFsc2U7XG4gIH1cbn07XG5cbi8vIFBhcnNlIG9iamVjdCBvciBjbGFzcyBtZXRob2QuXG5cbnBwLnBhcnNlTWV0aG9kID0gZnVuY3Rpb24gKGlzR2VuZXJhdG9yKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5pbml0RnVuY3Rpb24obm9kZSk7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtcbiAgbm9kZS5wYXJhbXMgPSB0aGlzLnBhcnNlQmluZGluZ0xpc3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIsIGZhbHNlLCBmYWxzZSk7XG4gIHZhciBhbGxvd0V4cHJlc3Npb25Cb2R5ID0gdW5kZWZpbmVkO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICBub2RlLmdlbmVyYXRvciA9IGlzR2VuZXJhdG9yO1xuICB9XG4gIHRoaXMucGFyc2VGdW5jdGlvbkJvZHkobm9kZSwgZmFsc2UpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRnVuY3Rpb25FeHByZXNzaW9uXCIpO1xufTtcblxuLy8gUGFyc2UgYXJyb3cgZnVuY3Rpb24gZXhwcmVzc2lvbiB3aXRoIGdpdmVuIHBhcmFtZXRlcnMuXG5cbnBwLnBhcnNlQXJyb3dFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHBhcmFtcykge1xuICB0aGlzLmluaXRGdW5jdGlvbihub2RlKTtcbiAgbm9kZS5wYXJhbXMgPSB0aGlzLnRvQXNzaWduYWJsZUxpc3QocGFyYW1zLCB0cnVlKTtcbiAgdGhpcy5wYXJzZUZ1bmN0aW9uQm9keShub2RlLCB0cnVlKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkFycm93RnVuY3Rpb25FeHByZXNzaW9uXCIpO1xufTtcblxuLy8gUGFyc2UgZnVuY3Rpb24gYm9keSBhbmQgY2hlY2sgcGFyYW1ldGVycy5cblxucHAucGFyc2VGdW5jdGlvbkJvZHkgPSBmdW5jdGlvbiAobm9kZSwgYWxsb3dFeHByZXNzaW9uKSB7XG4gIHZhciBpc0V4cHJlc3Npb24gPSBhbGxvd0V4cHJlc3Npb24gJiYgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDtcblxuICBpZiAoaXNFeHByZXNzaW9uKSB7XG4gICAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgbm9kZS5leHByZXNzaW9uID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICAvLyBTdGFydCBhIG5ldyBzY29wZSB3aXRoIHJlZ2FyZCB0byBsYWJlbHMgYW5kIHRoZSBgaW5GdW5jdGlvbmBcbiAgICAvLyBmbGFnIChyZXN0b3JlIHRoZW0gdG8gdGhlaXIgb2xkIHZhbHVlIGFmdGVyd2FyZHMpLlxuICAgIHZhciBvbGRJbkZ1bmMgPSB0aGlzLmluRnVuY3Rpb24sXG4gICAgICAgIG9sZEluR2VuID0gdGhpcy5pbkdlbmVyYXRvcixcbiAgICAgICAgb2xkTGFiZWxzID0gdGhpcy5sYWJlbHM7XG4gICAgdGhpcy5pbkZ1bmN0aW9uID0gdHJ1ZTt0aGlzLmluR2VuZXJhdG9yID0gbm9kZS5nZW5lcmF0b3I7dGhpcy5sYWJlbHMgPSBbXTtcbiAgICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlQmxvY2sodHJ1ZSk7XG4gICAgbm9kZS5leHByZXNzaW9uID0gZmFsc2U7XG4gICAgdGhpcy5pbkZ1bmN0aW9uID0gb2xkSW5GdW5jO3RoaXMuaW5HZW5lcmF0b3IgPSBvbGRJbkdlbjt0aGlzLmxhYmVscyA9IG9sZExhYmVscztcbiAgfVxuXG4gIC8vIElmIHRoaXMgaXMgYSBzdHJpY3QgbW9kZSBmdW5jdGlvbiwgdmVyaWZ5IHRoYXQgYXJndW1lbnQgbmFtZXNcbiAgLy8gYXJlIG5vdCByZXBlYXRlZCwgYW5kIGl0IGRvZXMgbm90IHRyeSB0byBiaW5kIHRoZSB3b3JkcyBgZXZhbGBcbiAgLy8gb3IgYGFyZ3VtZW50c2AuXG4gIGlmICh0aGlzLnN0cmljdCB8fCAhaXNFeHByZXNzaW9uICYmIG5vZGUuYm9keS5ib2R5Lmxlbmd0aCAmJiB0aGlzLmlzVXNlU3RyaWN0KG5vZGUuYm9keS5ib2R5WzBdKSkge1xuICAgIHZhciBuYW1lSGFzaCA9IHt9LFxuICAgICAgICBvbGRTdHJpY3QgPSB0aGlzLnN0cmljdDtcbiAgICB0aGlzLnN0cmljdCA9IHRydWU7XG4gICAgaWYgKG5vZGUuaWQpIHRoaXMuY2hlY2tMVmFsKG5vZGUuaWQsIHRydWUpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5wYXJhbXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHRoaXMuY2hlY2tMVmFsKG5vZGUucGFyYW1zW2ldLCB0cnVlLCBuYW1lSGFzaCk7XG4gICAgfXRoaXMuc3RyaWN0ID0gb2xkU3RyaWN0O1xuICB9XG59O1xuXG4vLyBQYXJzZXMgYSBjb21tYS1zZXBhcmF0ZWQgbGlzdCBvZiBleHByZXNzaW9ucywgYW5kIHJldHVybnMgdGhlbSBhc1xuLy8gYW4gYXJyYXkuIGBjbG9zZWAgaXMgdGhlIHRva2VuIHR5cGUgdGhhdCBlbmRzIHRoZSBsaXN0LCBhbmRcbi8vIGBhbGxvd0VtcHR5YCBjYW4gYmUgdHVybmVkIG9uIHRvIGFsbG93IHN1YnNlcXVlbnQgY29tbWFzIHdpdGhcbi8vIG5vdGhpbmcgaW4gYmV0d2VlbiB0aGVtIHRvIGJlIHBhcnNlZCBhcyBgbnVsbGAgKHdoaWNoIGlzIG5lZWRlZFxuLy8gZm9yIGFycmF5IGxpdGVyYWxzKS5cblxucHAucGFyc2VFeHByTGlzdCA9IGZ1bmN0aW9uIChjbG9zZSwgYWxsb3dUcmFpbGluZ0NvbW1hLCBhbGxvd0VtcHR5LCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBlbHRzID0gW10sXG4gICAgICBmaXJzdCA9IHRydWU7XG4gIHdoaWxlICghdGhpcy5lYXQoY2xvc2UpKSB7XG4gICAgaWYgKCFmaXJzdCkge1xuICAgICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7XG4gICAgICBpZiAoYWxsb3dUcmFpbGluZ0NvbW1hICYmIHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKGNsb3NlKSkgYnJlYWs7XG4gICAgfSBlbHNlIGZpcnN0ID0gZmFsc2U7XG5cbiAgICB2YXIgZWx0ID0gdW5kZWZpbmVkO1xuICAgIGlmIChhbGxvd0VtcHR5ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5jb21tYSkgZWx0ID0gbnVsbDtlbHNlIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpIGVsdCA9IHRoaXMucGFyc2VTcHJlYWQocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7ZWxzZSBlbHQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oZmFsc2UsIHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO1xuICAgIGVsdHMucHVzaChlbHQpO1xuICB9XG4gIHJldHVybiBlbHRzO1xufTtcblxuLy8gUGFyc2UgdGhlIG5leHQgdG9rZW4gYXMgYW4gaWRlbnRpZmllci4gSWYgYGxpYmVyYWxgIGlzIHRydWUgKHVzZWRcbi8vIHdoZW4gcGFyc2luZyBwcm9wZXJ0aWVzKSwgaXQgd2lsbCBhbHNvIGNvbnZlcnQga2V5d29yZHMgaW50b1xuLy8gaWRlbnRpZmllcnMuXG5cbnBwLnBhcnNlSWRlbnQgPSBmdW5jdGlvbiAobGliZXJhbCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIGlmIChsaWJlcmFsICYmIHRoaXMub3B0aW9ucy5hbGxvd1Jlc2VydmVkID09IFwibmV2ZXJcIikgbGliZXJhbCA9IGZhbHNlO1xuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpIHtcbiAgICBpZiAoIWxpYmVyYWwgJiYgKCF0aGlzLm9wdGlvbnMuYWxsb3dSZXNlcnZlZCAmJiB0aGlzLmlzUmVzZXJ2ZWRXb3JkKHRoaXMudmFsdWUpIHx8IHRoaXMuc3RyaWN0ICYmIF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0KHRoaXMudmFsdWUpICYmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiB8fCB0aGlzLmlucHV0LnNsaWNlKHRoaXMuc3RhcnQsIHRoaXMuZW5kKS5pbmRleE9mKFwiXFxcXFwiKSA9PSAtMSkpKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiVGhlIGtleXdvcmQgJ1wiICsgdGhpcy52YWx1ZSArIFwiJyBpcyByZXNlcnZlZFwiKTtcbiAgICBub2RlLm5hbWUgPSB0aGlzLnZhbHVlO1xuICB9IGVsc2UgaWYgKGxpYmVyYWwgJiYgdGhpcy50eXBlLmtleXdvcmQpIHtcbiAgICBub2RlLm5hbWUgPSB0aGlzLnR5cGUua2V5d29yZDtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgfVxuICB0aGlzLm5leHQoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIklkZW50aWZpZXJcIik7XG59O1xuXG4vLyBQYXJzZXMgeWllbGQgZXhwcmVzc2lvbiBpbnNpZGUgZ2VuZXJhdG9yLlxuXG5wcC5wYXJzZVlpZWxkID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMubmV4dCgpO1xuICBpZiAodGhpcy50eXBlID09IF90b2tlbnR5cGUudHlwZXMuc2VtaSB8fCB0aGlzLmNhbkluc2VydFNlbWljb2xvbigpIHx8IHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLnN0YXIgJiYgIXRoaXMudHlwZS5zdGFydHNFeHByKSB7XG4gICAgbm9kZS5kZWxlZ2F0ZSA9IGZhbHNlO1xuICAgIG5vZGUuYXJndW1lbnQgPSBudWxsO1xuICB9IGVsc2Uge1xuICAgIG5vZGUuZGVsZWdhdGUgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO1xuICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiWWllbGRFeHByZXNzaW9uXCIpO1xufTtcblxuLy8gUGFyc2VzIGFycmF5IGFuZCBnZW5lcmF0b3IgY29tcHJlaGVuc2lvbnMuXG5cbnBwLnBhcnNlQ29tcHJlaGVuc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBpc0dlbmVyYXRvcikge1xuICBub2RlLmJsb2NrcyA9IFtdO1xuICB3aGlsZSAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9mb3IpIHtcbiAgICB2YXIgYmxvY2sgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIHRoaXMubmV4dCgpO1xuICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtcbiAgICBibG9jay5sZWZ0ID0gdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7XG4gICAgdGhpcy5jaGVja0xWYWwoYmxvY2subGVmdCwgdHJ1ZSk7XG4gICAgdGhpcy5leHBlY3RDb250ZXh0dWFsKFwib2ZcIik7XG4gICAgYmxvY2sucmlnaHQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtcbiAgICBub2RlLmJsb2Nrcy5wdXNoKHRoaXMuZmluaXNoTm9kZShibG9jaywgXCJDb21wcmVoZW5zaW9uQmxvY2tcIikpO1xuICB9XG4gIG5vZGUuZmlsdGVyID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5faWYpID8gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpIDogbnVsbDtcbiAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgdGhpcy5leHBlY3QoaXNHZW5lcmF0b3IgPyBfdG9rZW50eXBlLnR5cGVzLnBhcmVuUiA6IF90b2tlbnR5cGUudHlwZXMuYnJhY2tldFIpO1xuICBub2RlLmdlbmVyYXRvciA9IGlzR2VuZXJhdG9yO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQ29tcHJlaGVuc2lvbkV4cHJlc3Npb25cIik7XG59O1xuXG59LHtcIi4vaWRlbnRpZmllclwiOjIsXCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi91dGlsXCI6MTV9XSwyOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcbi8vIFRoaXMgaXMgYSB0cmljayB0YWtlbiBmcm9tIEVzcHJpbWEuIEl0IHR1cm5zIG91dCB0aGF0LCBvblxuLy8gbm9uLUNocm9tZSBicm93c2VycywgdG8gY2hlY2sgd2hldGhlciBhIHN0cmluZyBpcyBpbiBhIHNldCwgYVxuLy8gcHJlZGljYXRlIGNvbnRhaW5pbmcgYSBiaWcgdWdseSBgc3dpdGNoYCBzdGF0ZW1lbnQgaXMgZmFzdGVyIHRoYW5cbi8vIGEgcmVndWxhciBleHByZXNzaW9uLCBhbmQgb24gQ2hyb21lIHRoZSB0d28gYXJlIGFib3V0IG9uIHBhci5cbi8vIFRoaXMgZnVuY3Rpb24gdXNlcyBgZXZhbGAgKG5vbi1sZXhpY2FsKSB0byBwcm9kdWNlIHN1Y2ggYVxuLy8gcHJlZGljYXRlIGZyb20gYSBzcGFjZS1zZXBhcmF0ZWQgc3RyaW5nIG9mIHdvcmRzLlxuLy9cbi8vIEl0IHN0YXJ0cyBieSBzb3J0aW5nIHRoZSB3b3JkcyBieSBsZW5ndGguXG5cblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5pc0lkZW50aWZpZXJTdGFydCA9IGlzSWRlbnRpZmllclN0YXJ0O1xuZXhwb3J0cy5pc0lkZW50aWZpZXJDaGFyID0gaXNJZGVudGlmaWVyQ2hhcjtcbmZ1bmN0aW9uIG1ha2VQcmVkaWNhdGUod29yZHMpIHtcbiAgd29yZHMgPSB3b3Jkcy5zcGxpdChcIiBcIik7XG4gIHZhciBmID0gXCJcIixcbiAgICAgIGNhdHMgPSBbXTtcbiAgb3V0OiBmb3IgKHZhciBpID0gMDsgaSA8IHdvcmRzLmxlbmd0aDsgKytpKSB7XG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBjYXRzLmxlbmd0aDsgKytqKSB7XG4gICAgICBpZiAoY2F0c1tqXVswXS5sZW5ndGggPT0gd29yZHNbaV0ubGVuZ3RoKSB7XG4gICAgICAgIGNhdHNbal0ucHVzaCh3b3Jkc1tpXSk7XG4gICAgICAgIGNvbnRpbnVlIG91dDtcbiAgICAgIH1cbiAgICB9Y2F0cy5wdXNoKFt3b3Jkc1tpXV0pO1xuICB9XG4gIGZ1bmN0aW9uIGNvbXBhcmVUbyhhcnIpIHtcbiAgICBpZiAoYXJyLmxlbmd0aCA9PSAxKSByZXR1cm4gZiArPSBcInJldHVybiBzdHIgPT09IFwiICsgSlNPTi5zdHJpbmdpZnkoYXJyWzBdKSArIFwiO1wiO1xuICAgIGYgKz0gXCJzd2l0Y2goc3RyKXtcIjtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGFyci5sZW5ndGg7ICsraSkge1xuICAgICAgZiArPSBcImNhc2UgXCIgKyBKU09OLnN0cmluZ2lmeShhcnJbaV0pICsgXCI6XCI7XG4gICAgfWYgKz0gXCJyZXR1cm4gdHJ1ZX1yZXR1cm4gZmFsc2U7XCI7XG4gIH1cblxuICAvLyBXaGVuIHRoZXJlIGFyZSBtb3JlIHRoYW4gdGhyZWUgbGVuZ3RoIGNhdGVnb3JpZXMsIGFuIG91dGVyXG4gIC8vIHN3aXRjaCBmaXJzdCBkaXNwYXRjaGVzIG9uIHRoZSBsZW5ndGhzLCB0byBzYXZlIG9uIGNvbXBhcmlzb25zLlxuXG4gIGlmIChjYXRzLmxlbmd0aCA+IDMpIHtcbiAgICBjYXRzLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICAgIHJldHVybiBiLmxlbmd0aCAtIGEubGVuZ3RoO1xuICAgIH0pO1xuICAgIGYgKz0gXCJzd2l0Y2goc3RyLmxlbmd0aCl7XCI7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBjYXRzLmxlbmd0aDsgKytpKSB7XG4gICAgICB2YXIgY2F0ID0gY2F0c1tpXTtcbiAgICAgIGYgKz0gXCJjYXNlIFwiICsgY2F0WzBdLmxlbmd0aCArIFwiOlwiO1xuICAgICAgY29tcGFyZVRvKGNhdCk7XG4gICAgfVxuICAgIGYgKz0gXCJ9XCI7XG5cbiAgICAvLyBPdGhlcndpc2UsIHNpbXBseSBnZW5lcmF0ZSBhIGZsYXQgYHN3aXRjaGAgc3RhdGVtZW50LlxuICB9IGVsc2Uge1xuICAgICAgY29tcGFyZVRvKHdvcmRzKTtcbiAgICB9XG4gIHJldHVybiBuZXcgRnVuY3Rpb24oXCJzdHJcIiwgZik7XG59XG5cbi8vIFJlc2VydmVkIHdvcmQgbGlzdHMgZm9yIHZhcmlvdXMgZGlhbGVjdHMgb2YgdGhlIGxhbmd1YWdlXG5cbnZhciByZXNlcnZlZFdvcmRzID0ge1xuICAzOiBtYWtlUHJlZGljYXRlKFwiYWJzdHJhY3QgYm9vbGVhbiBieXRlIGNoYXIgY2xhc3MgZG91YmxlIGVudW0gZXhwb3J0IGV4dGVuZHMgZmluYWwgZmxvYXQgZ290byBpbXBsZW1lbnRzIGltcG9ydCBpbnQgaW50ZXJmYWNlIGxvbmcgbmF0aXZlIHBhY2thZ2UgcHJpdmF0ZSBwcm90ZWN0ZWQgcHVibGljIHNob3J0IHN0YXRpYyBzdXBlciBzeW5jaHJvbml6ZWQgdGhyb3dzIHRyYW5zaWVudCB2b2xhdGlsZVwiKSxcbiAgNTogbWFrZVByZWRpY2F0ZShcImNsYXNzIGVudW0gZXh0ZW5kcyBzdXBlciBjb25zdCBleHBvcnQgaW1wb3J0XCIpLFxuICA2OiBtYWtlUHJlZGljYXRlKFwiZW51bSBhd2FpdFwiKSxcbiAgc3RyaWN0OiBtYWtlUHJlZGljYXRlKFwiaW1wbGVtZW50cyBpbnRlcmZhY2UgbGV0IHBhY2thZ2UgcHJpdmF0ZSBwcm90ZWN0ZWQgcHVibGljIHN0YXRpYyB5aWVsZFwiKSxcbiAgc3RyaWN0QmluZDogbWFrZVByZWRpY2F0ZShcImV2YWwgYXJndW1lbnRzXCIpXG59O1xuXG5leHBvcnRzLnJlc2VydmVkV29yZHMgPSByZXNlcnZlZFdvcmRzO1xuLy8gQW5kIHRoZSBrZXl3b3Jkc1xuXG52YXIgZWNtYTVBbmRMZXNzS2V5d29yZHMgPSBcImJyZWFrIGNhc2UgY2F0Y2ggY29udGludWUgZGVidWdnZXIgZGVmYXVsdCBkbyBlbHNlIGZpbmFsbHkgZm9yIGZ1bmN0aW9uIGlmIHJldHVybiBzd2l0Y2ggdGhyb3cgdHJ5IHZhciB3aGlsZSB3aXRoIG51bGwgdHJ1ZSBmYWxzZSBpbnN0YW5jZW9mIHR5cGVvZiB2b2lkIGRlbGV0ZSBuZXcgaW4gdGhpc1wiO1xuXG52YXIga2V5d29yZHMgPSB7XG4gIDU6IG1ha2VQcmVkaWNhdGUoZWNtYTVBbmRMZXNzS2V5d29yZHMpLFxuICA2OiBtYWtlUHJlZGljYXRlKGVjbWE1QW5kTGVzc0tleXdvcmRzICsgXCIgbGV0IGNvbnN0IGNsYXNzIGV4dGVuZHMgZXhwb3J0IGltcG9ydCB5aWVsZCBzdXBlclwiKVxufTtcblxuZXhwb3J0cy5rZXl3b3JkcyA9IGtleXdvcmRzO1xuLy8gIyMgQ2hhcmFjdGVyIGNhdGVnb3JpZXNcblxuLy8gQmlnIHVnbHkgcmVndWxhciBleHByZXNzaW9ucyB0aGF0IG1hdGNoIGNoYXJhY3RlcnMgaW4gdGhlXG4vLyB3aGl0ZXNwYWNlLCBpZGVudGlmaWVyLCBhbmQgaWRlbnRpZmllci1zdGFydCBjYXRlZ29yaWVzLiBUaGVzZVxuLy8gYXJlIG9ubHkgYXBwbGllZCB3aGVuIGEgY2hhcmFjdGVyIGlzIGZvdW5kIHRvIGFjdHVhbGx5IGhhdmUgYVxuLy8gY29kZSBwb2ludCBhYm92ZSAxMjguXG4vLyBHZW5lcmF0ZWQgYnkgYHRvb2xzL2dlbmVyYXRlLWlkZW50aWZpZXItcmVnZXguanNgLlxuXG52YXIgbm9uQVNDSUlpZGVudGlmaWVyU3RhcnRDaGFycyA9IFwiwqrCtcK6w4Atw5bDmC3DtsO4LcuBy4Yty5HLoC3LpMusy67NsC3NtM22zbfNui3Nvc2/zobOiC3Ois6Mzo4tzqHOoy3Ptc+3LdKB0oot1K/UsS3VltWZ1aEt1ofXkC3XqtewLdey2KAt2YrZrtmv2bEt25Pbldul26bbrtuv27ot27zbv9yQ3JIt3K/djS3epd6x34ot36rftN+137rgoIAt4KCV4KCa4KCk4KCo4KGALeChmOCioC3gorLgpIQt4KS54KS94KWQ4KWYLeCloeClsS3gpoDgpoUt4KaM4KaP4KaQ4KaTLeCmqOCmqi3gprDgprLgprYt4Ka54Ka94KeO4Kec4Ked4KefLeCnoeCnsOCnseCohS3gqIrgqI/gqJDgqJMt4Kio4KiqLeCosOCosuCos+CoteCotuCouOCoueCpmS3gqZzgqZ7gqbIt4Km04KqFLeCqjeCqjy3gqpHgqpMt4Kqo4KqqLeCqsOCqsuCqs+CqtS3gqrngqr3gq5Dgq6Dgq6HgrIUt4KyM4KyP4KyQ4KyTLeCsqOCsqi3grLDgrLLgrLPgrLUt4Ky54Ky94K2c4K2d4K2fLeCtoeCtseCug+CuhS3grorgro4t4K6Q4K6SLeCuleCumeCumuCunOCunuCun+Cuo+CupOCuqC3grqrgrq4t4K654K+Q4LCFLeCwjOCwji3gsJDgsJIt4LCo4LCqLeCwueCwveCxmOCxmeCxoOCxoeCyhS3gsozgso4t4LKQ4LKSLeCyqOCyqi3gsrPgsrUt4LK54LK94LOe4LOg4LOh4LOx4LOy4LSFLeC0jOC0ji3gtJDgtJIt4LS64LS94LWO4LWg4LWh4LW6LeC1v+C2hS3gtpbgtpot4Lax4LazLeC2u+C2veC3gC3gt4bguIEt4Liw4Liy4Liz4LmALeC5huC6geC6guC6hOC6h+C6iOC6iuC6jeC6lC3gupfgupkt4Lqf4LqhLeC6o+C6peC6p+C6quC6q+C6rS3gurDgurLgurPgur3gu4At4LuE4LuG4LucLeC7n+C8gOC9gC3gvYfgvYkt4L2s4L6ILeC+jOGAgC3hgKrhgL/hgZAt4YGV4YGaLeGBneGBoeGBpeGBpuGBri3hgbDhgbUt4YKB4YKO4YKgLeGDheGDh+GDjeGDkC3hg7rhg7wt4YmI4YmKLeGJjeGJkC3hiZbhiZjhiZot4Ymd4YmgLeGKiOGKii3hio3hipAt4Yqw4YqyLeGKteGKuC3hir7hi4Dhi4It4YuF4YuILeGLluGLmC3hjJDhjJIt4YyV4YyYLeGNmuGOgC3hjo/hjqAt4Y+04ZCBLeGZrOGZry3hmb/hmoEt4Zqa4ZqgLeGbquGbri3hm7jhnIAt4ZyM4ZyOLeGckeGcoC3hnLHhnYAt4Z2R4Z2gLeGdrOGdri3hnbDhnoAt4Z6z4Z+X4Z+c4aCgLeGht+GigC3hoqjhoqrhorAt4aO14aSALeGknuGlkC3hpa3hpbAt4aW04aaALeGmq+GngS3hp4fhqIAt4aiW4aigLeGplOGqp+GshS3hrLPhrYUt4a2L4a6DLeGuoOGuruGur+Guui3hr6XhsIAt4bCj4bGNLeGxj+Gxmi3hsb3hs6kt4bOs4bOuLeGzseGzteGztuG0gC3htr/huIAt4byV4byYLeG8neG8oC3hvYXhvYgt4b2N4b2QLeG9l+G9meG9m+G9neG9ny3hvb3hvoAt4b604b62LeG+vOG+vuG/gi3hv4Thv4Yt4b+M4b+QLeG/k+G/li3hv5vhv6At4b+s4b+yLeG/tOG/ti3hv7zigbHigb/igpAt4oKc4oSC4oSH4oSKLeKEk+KEleKEmC3ihJ3ihKTihKbihKjihKot4oS54oS8LeKEv+KFhS3ihYnihY7ihaAt4oaI4rCALeKwruKwsC3isZ7isaAt4rOk4rOrLeKzruKzsuKzs+K0gC3itKXitKfitK3itLAt4rWn4rWv4raALeK2luK2oC3itqbitqgt4rau4rawLeK2tuK2uC3itr7it4At4reG4reILeK3juK3kC3it5bit5gt4ree44CFLeOAh+OAoS3jgKnjgLEt44C144C4LeOAvOOBgS3jgpbjgpst44Kf44KhLeODuuODvC3jg7/jhIUt44St44SxLeOGjuOGoC3jhrrjh7At44e/45CALeS2teS4gC3pv4zqgIAt6pKM6pOQLeqTveqUgC3qmIzqmJAt6pif6piq6pir6pmALeqZruqZvy3qmp3qmqAt6puv6pyXLeqcn+qcoi3qnojqnost6p6O6p6QLeqereqesOqeseqfty3qoIHqoIMt6qCF6qCHLeqgiuqgjC3qoKLqoYAt6qGz6qKCLeqis+qjsi3qo7fqo7vqpIot6qSl6qSwLeqlhuqloC3qpbzqpoQt6qay6qeP6qegLeqnpOqnpi3qp6/qp7ot6qe+6qiALeqoqOqpgC3qqYLqqYQt6qmL6qmgLeqptuqpuuqpvi3qqq/qqrHqqrXqqrbqqrkt6qq96quA6quC6qubLeqrneqroC3qq6rqq7It6qu06qyBLeqshuqsiS3qrI7qrJEt6qyW6qygLeqspuqsqC3qrK7qrLAt6q2a6q2cLeqtn+qtpOqtpeqvgC3qr6LqsIAt7Z6j7Z6wLe2fhu2fiy3tn7vvpIAt76mt76mwLe+rme+sgC3vrIbvrJMt76yX76yd76yfLe+sqO+sqi3vrLbvrLgt76y876y+762A762B762D762E762GLe+use+vky3vtL3vtZAt77aP77aSLe+3h++3sC3vt7vvubAt77m077m2Le+7vO+8oS3vvLrvvYEt772a772mLe++vu+/gi3vv4fvv4ot77+P77+SLe+/l++/mi3vv5xcIjtcbnZhciBub25BU0NJSWlkZW50aWZpZXJDaGFycyA9IFwi4oCM4oCNwrfMgC3Nr86H0oMt0ofWkS3Wvda/14HXgteE14XXh9iQLdia2Yst2anZsNuWLduc258t26Tbp9uo26ot263bsC3budyR3LAt3Yrepi3esN+ALd+J36st37PgoJYt4KCZ4KCbLeCgo+CgpS3goKfgoKkt4KCt4KGZLeChm+CjpC3gpIPgpLot4KS84KS+LeClj+ClkS3gpZfgpaLgpaPgpaYt4KWv4KaBLeCmg+CmvOCmvi3gp4Tgp4fgp4jgp4st4KeN4KeX4Kei4Kej4KemLeCnr+CogS3gqIPgqLzgqL4t4KmC4KmH4KmI4KmLLeCpjeCpkeCppi3gqbHgqbXgqoEt4KqD4Kq84Kq+LeCrheCrhy3gq4ngq4st4KuN4Kui4Kuj4KumLeCrr+CsgS3grIPgrLzgrL4t4K2E4K2H4K2I4K2LLeCtjeCtluCtl+CtouCto+Ctpi3gra/groLgrr4t4K+C4K+GLeCviOCvii3gr43gr5fgr6Yt4K+v4LCALeCwg+Cwvi3gsYTgsYYt4LGI4LGKLeCxjeCxleCxluCxouCxo+Cxpi3gsa/gsoEt4LKD4LK84LK+LeCzhOCzhi3gs4jgs4ot4LON4LOV4LOW4LOi4LOj4LOmLeCzr+C0gS3gtIPgtL4t4LWE4LWGLeC1iOC1ii3gtY3gtZfgtaLgtaPgtaYt4LWv4LaC4LaD4LeK4LePLeC3lOC3luC3mC3gt5/gt6Yt4Lev4Ley4Lez4Lix4Li0LeC4uuC5hy3guY7guZAt4LmZ4Lqx4Lq0LeC6ueC6u+C6vOC7iC3gu43gu5At4LuZ4LyY4LyZ4LygLeC8qeC8teC8t+C8ueC8vuC8v+C9sS3gvoTgvobgvofgvo0t4L6X4L6ZLeC+vOC/huGAqy3hgL7hgYAt4YGJ4YGWLeGBmeGBni3hgaDhgaIt4YGk4YGnLeGBreGBsS3hgbThgoIt4YKN4YKPLeGCneGNnS3hjZ/hjakt4Y2x4ZySLeGclOGcsi3hnLThnZLhnZPhnbLhnbPhnrQt4Z+T4Z+d4Z+gLeGfqeGgiy3hoI3hoJAt4aCZ4aKp4aSgLeGkq+GksC3hpLvhpYYt4aWP4aawLeGngOGniOGnieGnkC3hp5rhqJct4aib4amVLeGpnuGpoC3hqbzhqb8t4aqJ4aqQLeGqmeGqsC3hqr3hrIAt4ayE4ay0LeGthOGtkC3hrZnhrast4a2z4a6ALeGuguGuoS3hrq3hrrAt4a654a+mLeGvs+GwpC3hsLfhsYAt4bGJ4bGQLeGxmeGzkC3hs5Lhs5Qt4bOo4bOt4bOyLeGztOGzuOGzueG3gC3ht7Xht7wt4be/4oC/4oGA4oGU4oOQLeKDnOKDoeKDpS3ig7Dis68t4rOx4rW/4regLeK3v+OAqi3jgK/jgpnjgprqmKAt6pip6pmv6pm0LeqZveqan+qbsOqbseqgguqghuqgi+qgoy3qoKfqooDqooHqorQt6qOE6qOQLeqjmeqjoC3qo7HqpIAt6qSJ6qSmLeqkreqlhy3qpZPqpoAt6qaD6qazLeqngOqnkC3qp5nqp6Xqp7At6qe56qipLeqotuqpg+qpjOqpjeqpkC3qqZnqqbst6qm96qqw6qqyLeqqtOqqt+qquOqqvuqqv+qrgeqrqy3qq6/qq7Xqq7bqr6Mt6q+q6q+s6q+t6q+wLeqvue+snu+4gC3vuI/vuKAt77it77iz77i077mNLe+5j++8kC3vvJnvvL9cIjtcblxudmFyIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0ID0gbmV3IFJlZ0V4cChcIltcIiArIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgKyBcIl1cIik7XG52YXIgbm9uQVNDSUlpZGVudGlmaWVyID0gbmV3IFJlZ0V4cChcIltcIiArIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgKyBub25BU0NJSWlkZW50aWZpZXJDaGFycyArIFwiXVwiKTtcblxubm9uQVNDSUlpZGVudGlmaWVyU3RhcnRDaGFycyA9IG5vbkFTQ0lJaWRlbnRpZmllckNoYXJzID0gbnVsbDtcblxuLy8gVGhlc2UgYXJlIGEgcnVuLWxlbmd0aCBhbmQgb2Zmc2V0IGVuY29kZWQgcmVwcmVzZW50YXRpb24gb2YgdGhlXG4vLyA+MHhmZmZmIGNvZGUgcG9pbnRzIHRoYXQgYXJlIGEgdmFsaWQgcGFydCBvZiBpZGVudGlmaWVycy4gVGhlXG4vLyBvZmZzZXQgc3RhcnRzIGF0IDB4MTAwMDAsIGFuZCBlYWNoIHBhaXIgb2YgbnVtYmVycyByZXByZXNlbnRzIGFuXG4vLyBvZmZzZXQgdG8gdGhlIG5leHQgcmFuZ2UsIGFuZCB0aGVuIGEgc2l6ZSBvZiB0aGUgcmFuZ2UuIFRoZXkgd2VyZVxuLy8gZ2VuZXJhdGVkIGJ5IHRvb2xzL2dlbmVyYXRlLWlkZW50aWZpZXItcmVnZXguanNcbnZhciBhc3RyYWxJZGVudGlmaWVyU3RhcnRDb2RlcyA9IFswLCAxMSwgMiwgMjUsIDIsIDE4LCAyLCAxLCAyLCAxNCwgMywgMTMsIDM1LCAxMjIsIDcwLCA1MiwgMjY4LCAyOCwgNCwgNDgsIDQ4LCAzMSwgMTcsIDI2LCA2LCAzNywgMTEsIDI5LCAzLCAzNSwgNSwgNywgMiwgNCwgNDMsIDE1NywgOTksIDM5LCA5LCA1MSwgMTU3LCAzMTAsIDEwLCAyMSwgMTEsIDcsIDE1MywgNSwgMywgMCwgMiwgNDMsIDIsIDEsIDQsIDAsIDMsIDIyLCAxMSwgMjIsIDEwLCAzMCwgOTgsIDIxLCAxMSwgMjUsIDcxLCA1NSwgNywgMSwgNjUsIDAsIDE2LCAzLCAyLCAyLCAyLCAyNiwgNDUsIDI4LCA0LCAyOCwgMzYsIDcsIDIsIDI3LCAyOCwgNTMsIDExLCAyMSwgMTEsIDE4LCAxNCwgMTcsIDExMSwgNzIsIDk1NSwgNTIsIDc2LCA0NCwgMzMsIDI0LCAyNywgMzUsIDQyLCAzNCwgNCwgMCwgMTMsIDQ3LCAxNSwgMywgMjIsIDAsIDM4LCAxNywgMiwgMjQsIDEzMywgNDYsIDM5LCA3LCAzLCAxLCAzLCAyMSwgMiwgNiwgMiwgMSwgMiwgNCwgNCwgMCwgMzIsIDQsIDI4NywgNDcsIDIxLCAxLCAyLCAwLCAxODUsIDQ2LCA4MiwgNDcsIDIxLCAwLCA2MCwgNDIsIDUwMiwgNjMsIDMyLCAwLCA0NDksIDU2LCAxMjg4LCA5MjAsIDEwNCwgMTEwLCAyOTYyLCAxMDcwLCAxMzI2NiwgNTY4LCA4LCAzMCwgMTE0LCAyOSwgMTksIDQ3LCAxNywgMywgMzIsIDIwLCA2LCAxOCwgODgxLCA2OCwgMTIsIDAsIDY3LCAxMiwgMTY0ODEsIDEsIDMwNzEsIDEwNiwgNiwgMTIsIDQsIDgsIDgsIDksIDU5OTEsIDg0LCAyLCA3MCwgMiwgMSwgMywgMCwgMywgMSwgMywgMywgMiwgMTEsIDIsIDAsIDIsIDYsIDIsIDY0LCAyLCAzLCAzLCA3LCAyLCA2LCAyLCAyNywgMiwgMywgMiwgNCwgMiwgMCwgNCwgNiwgMiwgMzM5LCAzLCAyNCwgMiwgMjQsIDIsIDMwLCAyLCAyNCwgMiwgMzAsIDIsIDI0LCAyLCAzMCwgMiwgMjQsIDIsIDMwLCAyLCAyNCwgMiwgNywgNDE0OSwgMTk2LCAxMzQwLCAzLCAyLCAyNiwgMiwgMSwgMiwgMCwgMywgMCwgMiwgOSwgMiwgMywgMiwgMCwgMiwgMCwgNywgMCwgNSwgMCwgMiwgMCwgMiwgMCwgMiwgMiwgMiwgMSwgMiwgMCwgMywgMCwgMiwgMCwgMiwgMCwgMiwgMCwgMiwgMCwgMiwgMSwgMiwgMCwgMywgMywgMiwgNiwgMiwgMywgMiwgMywgMiwgMCwgMiwgOSwgMiwgMTYsIDYsIDIsIDIsIDQsIDIsIDE2LCA0NDIxLCA0MjcxMCwgNDIsIDQxNDgsIDEyLCAyMjEsIDE2MzU1LCA1NDFdO1xudmFyIGFzdHJhbElkZW50aWZpZXJDb2RlcyA9IFs1MDksIDAsIDIyNywgMCwgMTUwLCA0LCAyOTQsIDksIDEzNjgsIDIsIDIsIDEsIDYsIDMsIDQxLCAyLCA1LCAwLCAxNjYsIDEsIDEzMDYsIDIsIDU0LCAxNCwgMzIsIDksIDE2LCAzLCA0NiwgMTAsIDU0LCA5LCA3LCAyLCAzNywgMTMsIDIsIDksIDUyLCAwLCAxMywgMiwgNDksIDEzLCAxNiwgOSwgODMsIDExLCAxNjgsIDExLCA2LCA5LCA4LCAyLCA1NywgMCwgMiwgNiwgMywgMSwgMywgMiwgMTAsIDAsIDExLCAxLCAzLCA2LCA0LCA0LCAzMTYsIDE5LCAxMywgOSwgMjE0LCA2LCAzLCA4LCAxMTIsIDE2LCAxNiwgOSwgODIsIDEyLCA5LCA5LCA1MzUsIDksIDIwODU1LCA5LCAxMzUsIDQsIDYwLCA2LCAyNiwgOSwgMTAxNiwgNDUsIDE3LCAzLCAxOTcyMywgMSwgNTMxOSwgNCwgNCwgNSwgOSwgNywgMywgNiwgMzEsIDMsIDE0OSwgMiwgMTQxOCwgNDksIDQzMDUsIDYsIDc5MjYxOCwgMjM5XTtcblxuLy8gVGhpcyBoYXMgYSBjb21wbGV4aXR5IGxpbmVhciB0byB0aGUgdmFsdWUgb2YgdGhlIGNvZGUuIFRoZVxuLy8gYXNzdW1wdGlvbiBpcyB0aGF0IGxvb2tpbmcgdXAgYXN0cmFsIGlkZW50aWZpZXIgY2hhcmFjdGVycyBpc1xuLy8gcmFyZS5cbmZ1bmN0aW9uIGlzSW5Bc3RyYWxTZXQoY29kZSwgc2V0KSB7XG4gIHZhciBwb3MgPSAweDEwMDAwO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHNldC5sZW5ndGg7IGkgKz0gMikge1xuICAgIHBvcyArPSBzZXRbaV07XG4gICAgaWYgKHBvcyA+IGNvZGUpIHJldHVybiBmYWxzZTtcbiAgICBwb3MgKz0gc2V0W2kgKyAxXTtcbiAgICBpZiAocG9zID49IGNvZGUpIHJldHVybiB0cnVlO1xuICB9XG59XG5cbi8vIFRlc3Qgd2hldGhlciBhIGdpdmVuIGNoYXJhY3RlciBjb2RlIHN0YXJ0cyBhbiBpZGVudGlmaWVyLlxuXG5mdW5jdGlvbiBpc0lkZW50aWZpZXJTdGFydChjb2RlLCBhc3RyYWwpIHtcbiAgaWYgKGNvZGUgPCA2NSkgcmV0dXJuIGNvZGUgPT09IDM2O1xuICBpZiAoY29kZSA8IDkxKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGNvZGUgPCA5NykgcmV0dXJuIGNvZGUgPT09IDk1O1xuICBpZiAoY29kZSA8IDEyMykgcmV0dXJuIHRydWU7XG4gIGlmIChjb2RlIDw9IDB4ZmZmZikgcmV0dXJuIGNvZGUgPj0gMHhhYSAmJiBub25BU0NJSWlkZW50aWZpZXJTdGFydC50ZXN0KFN0cmluZy5mcm9tQ2hhckNvZGUoY29kZSkpO1xuICBpZiAoYXN0cmFsID09PSBmYWxzZSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNJbkFzdHJhbFNldChjb2RlLCBhc3RyYWxJZGVudGlmaWVyU3RhcnRDb2Rlcyk7XG59XG5cbi8vIFRlc3Qgd2hldGhlciBhIGdpdmVuIGNoYXJhY3RlciBpcyBwYXJ0IG9mIGFuIGlkZW50aWZpZXIuXG5cbmZ1bmN0aW9uIGlzSWRlbnRpZmllckNoYXIoY29kZSwgYXN0cmFsKSB7XG4gIGlmIChjb2RlIDwgNDgpIHJldHVybiBjb2RlID09PSAzNjtcbiAgaWYgKGNvZGUgPCA1OCkgcmV0dXJuIHRydWU7XG4gIGlmIChjb2RlIDwgNjUpIHJldHVybiBmYWxzZTtcbiAgaWYgKGNvZGUgPCA5MSkgcmV0dXJuIHRydWU7XG4gIGlmIChjb2RlIDwgOTcpIHJldHVybiBjb2RlID09PSA5NTtcbiAgaWYgKGNvZGUgPCAxMjMpIHJldHVybiB0cnVlO1xuICBpZiAoY29kZSA8PSAweGZmZmYpIHJldHVybiBjb2RlID49IDB4YWEgJiYgbm9uQVNDSUlpZGVudGlmaWVyLnRlc3QoU3RyaW5nLmZyb21DaGFyQ29kZShjb2RlKSk7XG4gIGlmIChhc3RyYWwgPT09IGZhbHNlKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpc0luQXN0cmFsU2V0KGNvZGUsIGFzdHJhbElkZW50aWZpZXJTdGFydENvZGVzKSB8fCBpc0luQXN0cmFsU2V0KGNvZGUsIGFzdHJhbElkZW50aWZpZXJDb2Rlcyk7XG59XG5cbn0se31dLDM6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuLy8gQWNvcm4gaXMgYSB0aW55LCBmYXN0IEphdmFTY3JpcHQgcGFyc2VyIHdyaXR0ZW4gaW4gSmF2YVNjcmlwdC5cbi8vXG4vLyBBY29ybiB3YXMgd3JpdHRlbiBieSBNYXJpam4gSGF2ZXJiZWtlLCBJbmd2YXIgU3RlcGFueWFuLCBhbmRcbi8vIHZhcmlvdXMgY29udHJpYnV0b3JzIGFuZCByZWxlYXNlZCB1bmRlciBhbiBNSVQgbGljZW5zZS5cbi8vXG4vLyBHaXQgcmVwb3NpdG9yaWVzIGZvciBBY29ybiBhcmUgYXZhaWxhYmxlIGF0XG4vL1xuLy8gICAgIGh0dHA6Ly9tYXJpam5oYXZlcmJla2UubmwvZ2l0L2Fjb3JuXG4vLyAgICAgaHR0cHM6Ly9naXRodWIuY29tL21hcmlqbmgvYWNvcm4uZ2l0XG4vL1xuLy8gUGxlYXNlIHVzZSB0aGUgW2dpdGh1YiBidWcgdHJhY2tlcl1bZ2hidF0gdG8gcmVwb3J0IGlzc3Vlcy5cbi8vXG4vLyBbZ2hidF06IGh0dHBzOi8vZ2l0aHViLmNvbS9tYXJpam5oL2Fjb3JuL2lzc3Vlc1xuLy9cbi8vIFRoaXMgZmlsZSBkZWZpbmVzIHRoZSBtYWluIHBhcnNlciBpbnRlcmZhY2UuIFRoZSBsaWJyYXJ5IGFsc28gY29tZXNcbi8vIHdpdGggYSBbZXJyb3ItdG9sZXJhbnQgcGFyc2VyXVtkYW1taXRdIGFuZCBhblxuLy8gW2Fic3RyYWN0IHN5bnRheCB0cmVlIHdhbGtlcl1bd2Fsa10sIGRlZmluZWQgaW4gb3RoZXIgZmlsZXMuXG4vL1xuLy8gW2RhbW1pdF06IGFjb3JuX2xvb3NlLmpzXG4vLyBbd2Fsa106IHV0aWwvd2Fsay5qc1xuXG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMucGFyc2UgPSBwYXJzZTtcbmV4cG9ydHMucGFyc2VFeHByZXNzaW9uQXQgPSBwYXJzZUV4cHJlc3Npb25BdDtcbmV4cG9ydHMudG9rZW5pemVyID0gdG9rZW5pemVyO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfb3B0aW9ucyA9IF9kZXJlcV8oXCIuL29wdGlvbnNcIik7XG5cbl9kZXJlcV8oXCIuL3BhcnNldXRpbFwiKTtcblxuX2RlcmVxXyhcIi4vc3RhdGVtZW50XCIpO1xuXG5fZGVyZXFfKFwiLi9sdmFsXCIpO1xuXG5fZGVyZXFfKFwiLi9leHByZXNzaW9uXCIpO1xuXG5fZGVyZXFfKFwiLi9sb2NhdGlvblwiKTtcblxuZXhwb3J0cy5QYXJzZXIgPSBfc3RhdGUuUGFyc2VyO1xuZXhwb3J0cy5wbHVnaW5zID0gX3N0YXRlLnBsdWdpbnM7XG5leHBvcnRzLmRlZmF1bHRPcHRpb25zID0gX29wdGlvbnMuZGVmYXVsdE9wdGlvbnM7XG5cbnZhciBfbG9jdXRpbCA9IF9kZXJlcV8oXCIuL2xvY3V0aWxcIik7XG5cbmV4cG9ydHMuUG9zaXRpb24gPSBfbG9jdXRpbC5Qb3NpdGlvbjtcbmV4cG9ydHMuU291cmNlTG9jYXRpb24gPSBfbG9jdXRpbC5Tb3VyY2VMb2NhdGlvbjtcbmV4cG9ydHMuZ2V0TGluZUluZm8gPSBfbG9jdXRpbC5nZXRMaW5lSW5mbztcblxudmFyIF9ub2RlID0gX2RlcmVxXyhcIi4vbm9kZVwiKTtcblxuZXhwb3J0cy5Ob2RlID0gX25vZGUuTm9kZTtcblxudmFyIF90b2tlbnR5cGUgPSBfZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7XG5cbmV4cG9ydHMuVG9rZW5UeXBlID0gX3Rva2VudHlwZS5Ub2tlblR5cGU7XG5leHBvcnRzLnRva1R5cGVzID0gX3Rva2VudHlwZS50eXBlcztcblxudmFyIF90b2tlbmNvbnRleHQgPSBfZGVyZXFfKFwiLi90b2tlbmNvbnRleHRcIik7XG5cbmV4cG9ydHMuVG9rQ29udGV4dCA9IF90b2tlbmNvbnRleHQuVG9rQ29udGV4dDtcbmV4cG9ydHMudG9rQ29udGV4dHMgPSBfdG9rZW5jb250ZXh0LnR5cGVzO1xuXG52YXIgX2lkZW50aWZpZXIgPSBfZGVyZXFfKFwiLi9pZGVudGlmaWVyXCIpO1xuXG5leHBvcnRzLmlzSWRlbnRpZmllckNoYXIgPSBfaWRlbnRpZmllci5pc0lkZW50aWZpZXJDaGFyO1xuZXhwb3J0cy5pc0lkZW50aWZpZXJTdGFydCA9IF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0O1xuXG52YXIgX3Rva2VuaXplID0gX2RlcmVxXyhcIi4vdG9rZW5pemVcIik7XG5cbmV4cG9ydHMuVG9rZW4gPSBfdG9rZW5pemUuVG9rZW47XG5cbnZhciBfd2hpdGVzcGFjZSA9IF9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7XG5cbmV4cG9ydHMuaXNOZXdMaW5lID0gX3doaXRlc3BhY2UuaXNOZXdMaW5lO1xuZXhwb3J0cy5saW5lQnJlYWsgPSBfd2hpdGVzcGFjZS5saW5lQnJlYWs7XG5leHBvcnRzLmxpbmVCcmVha0cgPSBfd2hpdGVzcGFjZS5saW5lQnJlYWtHO1xudmFyIHZlcnNpb24gPSBcIjIuMi4wXCI7XG5cbmV4cG9ydHMudmVyc2lvbiA9IHZlcnNpb247XG4vLyBUaGUgbWFpbiBleHBvcnRlZCBpbnRlcmZhY2UgKHVuZGVyIGBzZWxmLmFjb3JuYCB3aGVuIGluIHRoZVxuLy8gYnJvd3NlcikgaXMgYSBgcGFyc2VgIGZ1bmN0aW9uIHRoYXQgdGFrZXMgYSBjb2RlIHN0cmluZyBhbmRcbi8vIHJldHVybnMgYW4gYWJzdHJhY3Qgc3ludGF4IHRyZWUgYXMgc3BlY2lmaWVkIGJ5IFtNb3ppbGxhIHBhcnNlclxuLy8gQVBJXVthcGldLlxuLy9cbi8vIFthcGldOiBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1NwaWRlck1vbmtleS9QYXJzZXJfQVBJXG5cbmZ1bmN0aW9uIHBhcnNlKGlucHV0LCBvcHRpb25zKSB7XG4gIHJldHVybiBuZXcgX3N0YXRlLlBhcnNlcihvcHRpb25zLCBpbnB1dCkucGFyc2UoKTtcbn1cblxuLy8gVGhpcyBmdW5jdGlvbiB0cmllcyB0byBwYXJzZSBhIHNpbmdsZSBleHByZXNzaW9uIGF0IGEgZ2l2ZW5cbi8vIG9mZnNldCBpbiBhIHN0cmluZy4gVXNlZnVsIGZvciBwYXJzaW5nIG1peGVkLWxhbmd1YWdlIGZvcm1hdHNcbi8vIHRoYXQgZW1iZWQgSmF2YVNjcmlwdCBleHByZXNzaW9ucy5cblxuZnVuY3Rpb24gcGFyc2VFeHByZXNzaW9uQXQoaW5wdXQsIHBvcywgb3B0aW9ucykge1xuICB2YXIgcCA9IG5ldyBfc3RhdGUuUGFyc2VyKG9wdGlvbnMsIGlucHV0LCBwb3MpO1xuICBwLm5leHRUb2tlbigpO1xuICByZXR1cm4gcC5wYXJzZUV4cHJlc3Npb24oKTtcbn1cblxuLy8gQWNvcm4gaXMgb3JnYW5pemVkIGFzIGEgdG9rZW5pemVyIGFuZCBhIHJlY3Vyc2l2ZS1kZXNjZW50IHBhcnNlci5cbi8vIFRoZSBgdG9rZW5pemVgIGV4cG9ydCBwcm92aWRlcyBhbiBpbnRlcmZhY2UgdG8gdGhlIHRva2VuaXplci5cblxuZnVuY3Rpb24gdG9rZW5pemVyKGlucHV0LCBvcHRpb25zKSB7XG4gIHJldHVybiBuZXcgX3N0YXRlLlBhcnNlcihvcHRpb25zLCBpbnB1dCk7XG59XG5cbn0se1wiLi9leHByZXNzaW9uXCI6MSxcIi4vaWRlbnRpZmllclwiOjIsXCIuL2xvY2F0aW9uXCI6NCxcIi4vbG9jdXRpbFwiOjUsXCIuL2x2YWxcIjo2LFwiLi9ub2RlXCI6NyxcIi4vb3B0aW9uc1wiOjgsXCIuL3BhcnNldXRpbFwiOjksXCIuL3N0YXRlXCI6MTAsXCIuL3N0YXRlbWVudFwiOjExLFwiLi90b2tlbmNvbnRleHRcIjoxMixcIi4vdG9rZW5pemVcIjoxMyxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDQ6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF9sb2N1dGlsID0gX2RlcmVxXyhcIi4vbG9jdXRpbFwiKTtcblxudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbi8vIFRoaXMgZnVuY3Rpb24gaXMgdXNlZCB0byByYWlzZSBleGNlcHRpb25zIG9uIHBhcnNlIGVycm9ycy4gSXRcbi8vIHRha2VzIGFuIG9mZnNldCBpbnRlZ2VyIChpbnRvIHRoZSBjdXJyZW50IGBpbnB1dGApIHRvIGluZGljYXRlXG4vLyB0aGUgbG9jYXRpb24gb2YgdGhlIGVycm9yLCBhdHRhY2hlcyB0aGUgcG9zaXRpb24gdG8gdGhlIGVuZFxuLy8gb2YgdGhlIGVycm9yIG1lc3NhZ2UsIGFuZCB0aGVuIHJhaXNlcyBhIGBTeW50YXhFcnJvcmAgd2l0aCB0aGF0XG4vLyBtZXNzYWdlLlxuXG5wcC5yYWlzZSA9IGZ1bmN0aW9uIChwb3MsIG1lc3NhZ2UpIHtcbiAgdmFyIGxvYyA9IF9sb2N1dGlsLmdldExpbmVJbmZvKHRoaXMuaW5wdXQsIHBvcyk7XG4gIG1lc3NhZ2UgKz0gXCIgKFwiICsgbG9jLmxpbmUgKyBcIjpcIiArIGxvYy5jb2x1bW4gKyBcIilcIjtcbiAgdmFyIGVyciA9IG5ldyBTeW50YXhFcnJvcihtZXNzYWdlKTtcbiAgZXJyLnBvcyA9IHBvcztlcnIubG9jID0gbG9jO2Vyci5yYWlzZWRBdCA9IHRoaXMucG9zO1xuICB0aHJvdyBlcnI7XG59O1xuXG5wcC5jdXJQb3NpdGlvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHtcbiAgICByZXR1cm4gbmV3IF9sb2N1dGlsLlBvc2l0aW9uKHRoaXMuY3VyTGluZSwgdGhpcy5wb3MgLSB0aGlzLmxpbmVTdGFydCk7XG4gIH1cbn07XG5cbn0se1wiLi9sb2N1dGlsXCI6NSxcIi4vc3RhdGVcIjoxMH1dLDU6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzLmdldExpbmVJbmZvID0gZ2V0TGluZUluZm87XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbnZhciBfd2hpdGVzcGFjZSA9IF9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7XG5cbi8vIFRoZXNlIGFyZSB1c2VkIHdoZW4gYG9wdGlvbnMubG9jYXRpb25zYCBpcyBvbiwgZm9yIHRoZVxuLy8gYHN0YXJ0TG9jYCBhbmQgYGVuZExvY2AgcHJvcGVydGllcy5cblxudmFyIFBvc2l0aW9uID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gUG9zaXRpb24obGluZSwgY29sKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFBvc2l0aW9uKTtcblxuICAgIHRoaXMubGluZSA9IGxpbmU7XG4gICAgdGhpcy5jb2x1bW4gPSBjb2w7XG4gIH1cblxuICBQb3NpdGlvbi5wcm90b3R5cGUub2Zmc2V0ID0gZnVuY3Rpb24gb2Zmc2V0KG4pIHtcbiAgICByZXR1cm4gbmV3IFBvc2l0aW9uKHRoaXMubGluZSwgdGhpcy5jb2x1bW4gKyBuKTtcbiAgfTtcblxuICByZXR1cm4gUG9zaXRpb247XG59KSgpO1xuXG5leHBvcnRzLlBvc2l0aW9uID0gUG9zaXRpb247XG5cbnZhciBTb3VyY2VMb2NhdGlvbiA9IGZ1bmN0aW9uIFNvdXJjZUxvY2F0aW9uKHAsIHN0YXJ0LCBlbmQpIHtcbiAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFNvdXJjZUxvY2F0aW9uKTtcblxuICB0aGlzLnN0YXJ0ID0gc3RhcnQ7XG4gIHRoaXMuZW5kID0gZW5kO1xuICBpZiAocC5zb3VyY2VGaWxlICE9PSBudWxsKSB0aGlzLnNvdXJjZSA9IHAuc291cmNlRmlsZTtcbn1cblxuLy8gVGhlIGBnZXRMaW5lSW5mb2AgZnVuY3Rpb24gaXMgbW9zdGx5IHVzZWZ1bCB3aGVuIHRoZVxuLy8gYGxvY2F0aW9uc2Agb3B0aW9uIGlzIG9mZiAoZm9yIHBlcmZvcm1hbmNlIHJlYXNvbnMpIGFuZCB5b3Vcbi8vIHdhbnQgdG8gZmluZCB0aGUgbGluZS9jb2x1bW4gcG9zaXRpb24gZm9yIGEgZ2l2ZW4gY2hhcmFjdGVyXG4vLyBvZmZzZXQuIGBpbnB1dGAgc2hvdWxkIGJlIHRoZSBjb2RlIHN0cmluZyB0aGF0IHRoZSBvZmZzZXQgcmVmZXJzXG4vLyBpbnRvLlxuXG47XG5cbmV4cG9ydHMuU291cmNlTG9jYXRpb24gPSBTb3VyY2VMb2NhdGlvbjtcblxuZnVuY3Rpb24gZ2V0TGluZUluZm8oaW5wdXQsIG9mZnNldCkge1xuICBmb3IgKHZhciBsaW5lID0gMSwgY3VyID0gMDs7KSB7XG4gICAgX3doaXRlc3BhY2UubGluZUJyZWFrRy5sYXN0SW5kZXggPSBjdXI7XG4gICAgdmFyIG1hdGNoID0gX3doaXRlc3BhY2UubGluZUJyZWFrRy5leGVjKGlucHV0KTtcbiAgICBpZiAobWF0Y2ggJiYgbWF0Y2guaW5kZXggPCBvZmZzZXQpIHtcbiAgICAgICsrbGluZTtcbiAgICAgIGN1ciA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gbmV3IFBvc2l0aW9uKGxpbmUsIG9mZnNldCAtIGN1cik7XG4gICAgfVxuICB9XG59XG5cbn0se1wiLi93aGl0ZXNwYWNlXCI6MTZ9XSw2OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgX3Rva2VudHlwZSA9IF9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTtcblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgX2lkZW50aWZpZXIgPSBfZGVyZXFfKFwiLi9pZGVudGlmaWVyXCIpO1xuXG52YXIgX3V0aWwgPSBfZGVyZXFfKFwiLi91dGlsXCIpO1xuXG52YXIgcHAgPSBfc3RhdGUuUGFyc2VyLnByb3RvdHlwZTtcblxuLy8gQ29udmVydCBleGlzdGluZyBleHByZXNzaW9uIGF0b20gdG8gYXNzaWduYWJsZSBwYXR0ZXJuXG4vLyBpZiBwb3NzaWJsZS5cblxucHAudG9Bc3NpZ25hYmxlID0gZnVuY3Rpb24gKG5vZGUsIGlzQmluZGluZykge1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgbm9kZSkge1xuICAgIHN3aXRjaCAobm9kZS50eXBlKSB7XG4gICAgICBjYXNlIFwiSWRlbnRpZmllclwiOlxuICAgICAgY2FzZSBcIk9iamVjdFBhdHRlcm5cIjpcbiAgICAgIGNhc2UgXCJBcnJheVBhdHRlcm5cIjpcbiAgICAgIGNhc2UgXCJBc3NpZ25tZW50UGF0dGVyblwiOlxuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIk9iamVjdEV4cHJlc3Npb25cIjpcbiAgICAgICAgbm9kZS50eXBlID0gXCJPYmplY3RQYXR0ZXJuXCI7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5wcm9wZXJ0aWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgdmFyIHByb3AgPSBub2RlLnByb3BlcnRpZXNbaV07XG4gICAgICAgICAgaWYgKHByb3Aua2luZCAhPT0gXCJpbml0XCIpIHRoaXMucmFpc2UocHJvcC5rZXkuc3RhcnQsIFwiT2JqZWN0IHBhdHRlcm4gY2FuJ3QgY29udGFpbiBnZXR0ZXIgb3Igc2V0dGVyXCIpO1xuICAgICAgICAgIHRoaXMudG9Bc3NpZ25hYmxlKHByb3AudmFsdWUsIGlzQmluZGluZyk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJBcnJheUV4cHJlc3Npb25cIjpcbiAgICAgICAgbm9kZS50eXBlID0gXCJBcnJheVBhdHRlcm5cIjtcbiAgICAgICAgdGhpcy50b0Fzc2lnbmFibGVMaXN0KG5vZGUuZWxlbWVudHMsIGlzQmluZGluZyk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiQXNzaWdubWVudEV4cHJlc3Npb25cIjpcbiAgICAgICAgaWYgKG5vZGUub3BlcmF0b3IgPT09IFwiPVwiKSB7XG4gICAgICAgICAgbm9kZS50eXBlID0gXCJBc3NpZ25tZW50UGF0dGVyblwiO1xuICAgICAgICAgIGRlbGV0ZSBub2RlLm9wZXJhdG9yO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMucmFpc2Uobm9kZS5sZWZ0LmVuZCwgXCJPbmx5ICc9JyBvcGVyYXRvciBjYW4gYmUgdXNlZCBmb3Igc3BlY2lmeWluZyBkZWZhdWx0IHZhbHVlLlwiKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uXCI6XG4gICAgICAgIG5vZGUuZXhwcmVzc2lvbiA9IHRoaXMudG9Bc3NpZ25hYmxlKG5vZGUuZXhwcmVzc2lvbiwgaXNCaW5kaW5nKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJNZW1iZXJFeHByZXNzaW9uXCI6XG4gICAgICAgIGlmICghaXNCaW5kaW5nKSBicmVhaztcblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhpcy5yYWlzZShub2RlLnN0YXJ0LCBcIkFzc2lnbmluZyB0byBydmFsdWVcIik7XG4gICAgfVxuICB9XG4gIHJldHVybiBub2RlO1xufTtcblxuLy8gQ29udmVydCBsaXN0IG9mIGV4cHJlc3Npb24gYXRvbXMgdG8gYmluZGluZyBsaXN0LlxuXG5wcC50b0Fzc2lnbmFibGVMaXN0ID0gZnVuY3Rpb24gKGV4cHJMaXN0LCBpc0JpbmRpbmcpIHtcbiAgdmFyIGVuZCA9IGV4cHJMaXN0Lmxlbmd0aDtcbiAgaWYgKGVuZCkge1xuICAgIHZhciBsYXN0ID0gZXhwckxpc3RbZW5kIC0gMV07XG4gICAgaWYgKGxhc3QgJiYgbGFzdC50eXBlID09IFwiUmVzdEVsZW1lbnRcIikge1xuICAgICAgLS1lbmQ7XG4gICAgfSBlbHNlIGlmIChsYXN0ICYmIGxhc3QudHlwZSA9PSBcIlNwcmVhZEVsZW1lbnRcIikge1xuICAgICAgbGFzdC50eXBlID0gXCJSZXN0RWxlbWVudFwiO1xuICAgICAgdmFyIGFyZyA9IGxhc3QuYXJndW1lbnQ7XG4gICAgICB0aGlzLnRvQXNzaWduYWJsZShhcmcsIGlzQmluZGluZyk7XG4gICAgICBpZiAoYXJnLnR5cGUgIT09IFwiSWRlbnRpZmllclwiICYmIGFyZy50eXBlICE9PSBcIk1lbWJlckV4cHJlc3Npb25cIiAmJiBhcmcudHlwZSAhPT0gXCJBcnJheVBhdHRlcm5cIikgdGhpcy51bmV4cGVjdGVkKGFyZy5zdGFydCk7XG4gICAgICAtLWVuZDtcbiAgICB9XG4gIH1cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBlbmQ7IGkrKykge1xuICAgIHZhciBlbHQgPSBleHByTGlzdFtpXTtcbiAgICBpZiAoZWx0KSB0aGlzLnRvQXNzaWduYWJsZShlbHQsIGlzQmluZGluZyk7XG4gIH1cbiAgcmV0dXJuIGV4cHJMaXN0O1xufTtcblxuLy8gUGFyc2VzIHNwcmVhZCBlbGVtZW50LlxuXG5wcC5wYXJzZVNwcmVhZCA9IGZ1bmN0aW9uIChyZWZTaG9ydGhhbmREZWZhdWx0UG9zKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24ocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJTcHJlYWRFbGVtZW50XCIpO1xufTtcblxucHAucGFyc2VSZXN0ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMubmV4dCgpO1xuICBub2RlLmFyZ3VtZW50ID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRMID8gdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCkgOiB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlJlc3RFbGVtZW50XCIpO1xufTtcblxuLy8gUGFyc2VzIGx2YWx1ZSAoYXNzaWduYWJsZSkgYXRvbS5cblxucHAucGFyc2VCaW5kaW5nQXRvbSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA8IDYpIHJldHVybiB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgc3dpdGNoICh0aGlzLnR5cGUpIHtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMubmFtZTpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlSWRlbnQoKTtcblxuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5icmFja2V0TDpcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgbm9kZS5lbGVtZW50cyA9IHRoaXMucGFyc2VCaW5kaW5nTGlzdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSLCB0cnVlLCB0cnVlKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJBcnJheVBhdHRlcm5cIik7XG5cbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2VMOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VPYmoodHJ1ZSk7XG5cbiAgICBkZWZhdWx0OlxuICAgICAgdGhpcy51bmV4cGVjdGVkKCk7XG4gIH1cbn07XG5cbnBwLnBhcnNlQmluZGluZ0xpc3QgPSBmdW5jdGlvbiAoY2xvc2UsIGFsbG93RW1wdHksIGFsbG93VHJhaWxpbmdDb21tYSkge1xuICB2YXIgZWx0cyA9IFtdLFxuICAgICAgZmlyc3QgPSB0cnVlO1xuICB3aGlsZSAoIXRoaXMuZWF0KGNsb3NlKSkge1xuICAgIGlmIChmaXJzdCkgZmlyc3QgPSBmYWxzZTtlbHNlIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO1xuICAgIGlmIChhbGxvd0VtcHR5ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5jb21tYSkge1xuICAgICAgZWx0cy5wdXNoKG51bGwpO1xuICAgIH0gZWxzZSBpZiAoYWxsb3dUcmFpbGluZ0NvbW1hICYmIHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKGNsb3NlKSkge1xuICAgICAgYnJlYWs7XG4gICAgfSBlbHNlIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpIHtcbiAgICAgIHZhciByZXN0ID0gdGhpcy5wYXJzZVJlc3QoKTtcbiAgICAgIHRoaXMucGFyc2VCaW5kaW5nTGlzdEl0ZW0ocmVzdCk7XG4gICAgICBlbHRzLnB1c2gocmVzdCk7XG4gICAgICB0aGlzLmV4cGVjdChjbG9zZSk7XG4gICAgICBicmVhaztcbiAgICB9IGVsc2Uge1xuICAgICAgdmFyIGVsZW0gPSB0aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHRoaXMuc3RhcnQsIHRoaXMuc3RhcnRMb2MpO1xuICAgICAgdGhpcy5wYXJzZUJpbmRpbmdMaXN0SXRlbShlbGVtKTtcbiAgICAgIGVsdHMucHVzaChlbGVtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGVsdHM7XG59O1xuXG5wcC5wYXJzZUJpbmRpbmdMaXN0SXRlbSA9IGZ1bmN0aW9uIChwYXJhbSkge1xuICByZXR1cm4gcGFyYW07XG59O1xuXG4vLyBQYXJzZXMgYXNzaWdubWVudCBwYXR0ZXJuIGFyb3VuZCBnaXZlbiBhdG9tIGlmIHBvc3NpYmxlLlxuXG5wcC5wYXJzZU1heWJlRGVmYXVsdCA9IGZ1bmN0aW9uIChzdGFydFBvcywgc3RhcnRMb2MsIGxlZnQpIHtcbiAgbGVmdCA9IGxlZnQgfHwgdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7XG4gIGlmICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5lcSkpIHJldHVybiBsZWZ0O1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3MsIHN0YXJ0TG9jKTtcbiAgbm9kZS5sZWZ0ID0gbGVmdDtcbiAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQXNzaWdubWVudFBhdHRlcm5cIik7XG59O1xuXG4vLyBWZXJpZnkgdGhhdCBhIG5vZGUgaXMgYW4gbHZhbCDigJQgc29tZXRoaW5nIHRoYXQgY2FuIGJlIGFzc2lnbmVkXG4vLyB0by5cblxucHAuY2hlY2tMVmFsID0gZnVuY3Rpb24gKGV4cHIsIGlzQmluZGluZywgY2hlY2tDbGFzaGVzKSB7XG4gIHN3aXRjaCAoZXhwci50eXBlKSB7XG4gICAgY2FzZSBcIklkZW50aWZpZXJcIjpcbiAgICAgIGlmICh0aGlzLnN0cmljdCAmJiAoX2lkZW50aWZpZXIucmVzZXJ2ZWRXb3Jkcy5zdHJpY3RCaW5kKGV4cHIubmFtZSkgfHwgX2lkZW50aWZpZXIucmVzZXJ2ZWRXb3Jkcy5zdHJpY3QoZXhwci5uYW1lKSkpIHRoaXMucmFpc2UoZXhwci5zdGFydCwgKGlzQmluZGluZyA/IFwiQmluZGluZyBcIiA6IFwiQXNzaWduaW5nIHRvIFwiKSArIGV4cHIubmFtZSArIFwiIGluIHN0cmljdCBtb2RlXCIpO1xuICAgICAgaWYgKGNoZWNrQ2xhc2hlcykge1xuICAgICAgICBpZiAoX3V0aWwuaGFzKGNoZWNrQ2xhc2hlcywgZXhwci5uYW1lKSkgdGhpcy5yYWlzZShleHByLnN0YXJ0LCBcIkFyZ3VtZW50IG5hbWUgY2xhc2ggaW4gc3RyaWN0IG1vZGVcIik7XG4gICAgICAgIGNoZWNrQ2xhc2hlc1tleHByLm5hbWVdID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcIk1lbWJlckV4cHJlc3Npb25cIjpcbiAgICAgIGlmIChpc0JpbmRpbmcpIHRoaXMucmFpc2UoZXhwci5zdGFydCwgKGlzQmluZGluZyA/IFwiQmluZGluZ1wiIDogXCJBc3NpZ25pbmcgdG9cIikgKyBcIiBtZW1iZXIgZXhwcmVzc2lvblwiKTtcbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcIk9iamVjdFBhdHRlcm5cIjpcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgZXhwci5wcm9wZXJ0aWVzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHRoaXMuY2hlY2tMVmFsKGV4cHIucHJvcGVydGllc1tpXS52YWx1ZSwgaXNCaW5kaW5nLCBjaGVja0NsYXNoZXMpO1xuICAgICAgfWJyZWFrO1xuXG4gICAgY2FzZSBcIkFycmF5UGF0dGVyblwiOlxuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBleHByLmVsZW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIHZhciBlbGVtID0gZXhwci5lbGVtZW50c1tpXTtcbiAgICAgICAgaWYgKGVsZW0pIHRoaXMuY2hlY2tMVmFsKGVsZW0sIGlzQmluZGluZywgY2hlY2tDbGFzaGVzKTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcIkFzc2lnbm1lbnRQYXR0ZXJuXCI6XG4gICAgICB0aGlzLmNoZWNrTFZhbChleHByLmxlZnQsIGlzQmluZGluZywgY2hlY2tDbGFzaGVzKTtcbiAgICAgIGJyZWFrO1xuXG4gICAgY2FzZSBcIlJlc3RFbGVtZW50XCI6XG4gICAgICB0aGlzLmNoZWNrTFZhbChleHByLmFyZ3VtZW50LCBpc0JpbmRpbmcsIGNoZWNrQ2xhc2hlcyk7XG4gICAgICBicmVhaztcblxuICAgIGNhc2UgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiOlxuICAgICAgdGhpcy5jaGVja0xWYWwoZXhwci5leHByZXNzaW9uLCBpc0JpbmRpbmcsIGNoZWNrQ2xhc2hlcyk7XG4gICAgICBicmVhaztcblxuICAgIGRlZmF1bHQ6XG4gICAgICB0aGlzLnJhaXNlKGV4cHIuc3RhcnQsIChpc0JpbmRpbmcgPyBcIkJpbmRpbmdcIiA6IFwiQXNzaWduaW5nIHRvXCIpICsgXCIgcnZhbHVlXCIpO1xuICB9XG59O1xuXG59LHtcIi4vaWRlbnRpZmllclwiOjIsXCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi91dGlsXCI6MTV9XSw3OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfbG9jdXRpbCA9IF9kZXJlcV8oXCIuL2xvY3V0aWxcIik7XG5cbnZhciBOb2RlID0gZnVuY3Rpb24gTm9kZShwYXJzZXIsIHBvcywgbG9jKSB7XG4gIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBOb2RlKTtcblxuICB0aGlzLnR5cGUgPSBcIlwiO1xuICB0aGlzLnN0YXJ0ID0gcG9zO1xuICB0aGlzLmVuZCA9IDA7XG4gIGlmIChwYXJzZXIub3B0aW9ucy5sb2NhdGlvbnMpIHRoaXMubG9jID0gbmV3IF9sb2N1dGlsLlNvdXJjZUxvY2F0aW9uKHBhcnNlciwgbG9jKTtcbiAgaWYgKHBhcnNlci5vcHRpb25zLmRpcmVjdFNvdXJjZUZpbGUpIHRoaXMuc291cmNlRmlsZSA9IHBhcnNlci5vcHRpb25zLmRpcmVjdFNvdXJjZUZpbGU7XG4gIGlmIChwYXJzZXIub3B0aW9ucy5yYW5nZXMpIHRoaXMucmFuZ2UgPSBbcG9zLCAwXTtcbn1cblxuLy8gU3RhcnQgYW4gQVNUIG5vZGUsIGF0dGFjaGluZyBhIHN0YXJ0IG9mZnNldC5cblxuO1xuXG5leHBvcnRzLk5vZGUgPSBOb2RlO1xudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbnBwLnN0YXJ0Tm9kZSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIG5ldyBOb2RlKHRoaXMsIHRoaXMuc3RhcnQsIHRoaXMuc3RhcnRMb2MpO1xufTtcblxucHAuc3RhcnROb2RlQXQgPSBmdW5jdGlvbiAocG9zLCBsb2MpIHtcbiAgcmV0dXJuIG5ldyBOb2RlKHRoaXMsIHBvcywgbG9jKTtcbn07XG5cbi8vIEZpbmlzaCBhbiBBU1Qgbm9kZSwgYWRkaW5nIGB0eXBlYCBhbmQgYGVuZGAgcHJvcGVydGllcy5cblxuZnVuY3Rpb24gZmluaXNoTm9kZUF0KG5vZGUsIHR5cGUsIHBvcywgbG9jKSB7XG4gIG5vZGUudHlwZSA9IHR5cGU7XG4gIG5vZGUuZW5kID0gcG9zO1xuICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykgbm9kZS5sb2MuZW5kID0gbG9jO1xuICBpZiAodGhpcy5vcHRpb25zLnJhbmdlcykgbm9kZS5yYW5nZVsxXSA9IHBvcztcbiAgcmV0dXJuIG5vZGU7XG59XG5cbnBwLmZpbmlzaE5vZGUgPSBmdW5jdGlvbiAobm9kZSwgdHlwZSkge1xuICByZXR1cm4gZmluaXNoTm9kZUF0LmNhbGwodGhpcywgbm9kZSwgdHlwZSwgdGhpcy5sYXN0VG9rRW5kLCB0aGlzLmxhc3RUb2tFbmRMb2MpO1xufTtcblxuLy8gRmluaXNoIG5vZGUgYXQgZ2l2ZW4gcG9zaXRpb25cblxucHAuZmluaXNoTm9kZUF0ID0gZnVuY3Rpb24gKG5vZGUsIHR5cGUsIHBvcywgbG9jKSB7XG4gIHJldHVybiBmaW5pc2hOb2RlQXQuY2FsbCh0aGlzLCBub2RlLCB0eXBlLCBwb3MsIGxvYyk7XG59O1xuXG59LHtcIi4vbG9jdXRpbFwiOjUsXCIuL3N0YXRlXCI6MTB9XSw4OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5nZXRPcHRpb25zID0gZ2V0T3B0aW9ucztcblxudmFyIF91dGlsID0gX2RlcmVxXyhcIi4vdXRpbFwiKTtcblxudmFyIF9sb2N1dGlsID0gX2RlcmVxXyhcIi4vbG9jdXRpbFwiKTtcblxuLy8gQSBzZWNvbmQgb3B0aW9uYWwgYXJndW1lbnQgY2FuIGJlIGdpdmVuIHRvIGZ1cnRoZXIgY29uZmlndXJlXG4vLyB0aGUgcGFyc2VyIHByb2Nlc3MuIFRoZXNlIG9wdGlvbnMgYXJlIHJlY29nbml6ZWQ6XG5cbnZhciBkZWZhdWx0T3B0aW9ucyA9IHtcbiAgLy8gYGVjbWFWZXJzaW9uYCBpbmRpY2F0ZXMgdGhlIEVDTUFTY3JpcHQgdmVyc2lvbiB0byBwYXJzZS4gTXVzdFxuICAvLyBiZSBlaXRoZXIgMywgb3IgNSwgb3IgNi4gVGhpcyBpbmZsdWVuY2VzIHN1cHBvcnQgZm9yIHN0cmljdFxuICAvLyBtb2RlLCB0aGUgc2V0IG9mIHJlc2VydmVkIHdvcmRzLCBzdXBwb3J0IGZvciBnZXR0ZXJzIGFuZFxuICAvLyBzZXR0ZXJzIGFuZCBvdGhlciBmZWF0dXJlcy5cbiAgZWNtYVZlcnNpb246IDUsXG4gIC8vIFNvdXJjZSB0eXBlIChcInNjcmlwdFwiIG9yIFwibW9kdWxlXCIpIGZvciBkaWZmZXJlbnQgc2VtYW50aWNzXG4gIHNvdXJjZVR5cGU6IFwic2NyaXB0XCIsXG4gIC8vIGBvbkluc2VydGVkU2VtaWNvbG9uYCBjYW4gYmUgYSBjYWxsYmFjayB0aGF0IHdpbGwgYmUgY2FsbGVkXG4gIC8vIHdoZW4gYSBzZW1pY29sb24gaXMgYXV0b21hdGljYWxseSBpbnNlcnRlZC4gSXQgd2lsbCBiZSBwYXNzZWRcbiAgLy8gdGggcG9zaXRpb24gb2YgdGhlIGNvbW1hIGFzIGFuIG9mZnNldCwgYW5kIGlmIGBsb2NhdGlvbnNgIGlzXG4gIC8vIGVuYWJsZWQsIGl0IGlzIGdpdmVuIHRoZSBsb2NhdGlvbiBhcyBhIGB7bGluZSwgY29sdW1ufWAgb2JqZWN0XG4gIC8vIGFzIHNlY29uZCBhcmd1bWVudC5cbiAgb25JbnNlcnRlZFNlbWljb2xvbjogbnVsbCxcbiAgLy8gYG9uVHJhaWxpbmdDb21tYWAgaXMgc2ltaWxhciB0byBgb25JbnNlcnRlZFNlbWljb2xvbmAsIGJ1dCBmb3JcbiAgLy8gdHJhaWxpbmcgY29tbWFzLlxuICBvblRyYWlsaW5nQ29tbWE6IG51bGwsXG4gIC8vIEJ5IGRlZmF1bHQsIHJlc2VydmVkIHdvcmRzIGFyZSBub3QgZW5mb3JjZWQuIERpc2FibGVcbiAgLy8gYGFsbG93UmVzZXJ2ZWRgIHRvIGVuZm9yY2UgdGhlbS4gV2hlbiB0aGlzIG9wdGlvbiBoYXMgdGhlXG4gIC8vIHZhbHVlIFwibmV2ZXJcIiwgcmVzZXJ2ZWQgd29yZHMgYW5kIGtleXdvcmRzIGNhbiBhbHNvIG5vdCBiZVxuICAvLyB1c2VkIGFzIHByb3BlcnR5IG5hbWVzLlxuICBhbGxvd1Jlc2VydmVkOiB0cnVlLFxuICAvLyBXaGVuIGVuYWJsZWQsIGEgcmV0dXJuIGF0IHRoZSB0b3AgbGV2ZWwgaXMgbm90IGNvbnNpZGVyZWQgYW5cbiAgLy8gZXJyb3IuXG4gIGFsbG93UmV0dXJuT3V0c2lkZUZ1bmN0aW9uOiBmYWxzZSxcbiAgLy8gV2hlbiBlbmFibGVkLCBpbXBvcnQvZXhwb3J0IHN0YXRlbWVudHMgYXJlIG5vdCBjb25zdHJhaW5lZCB0b1xuICAvLyBhcHBlYXJpbmcgYXQgdGhlIHRvcCBvZiB0aGUgcHJvZ3JhbS5cbiAgYWxsb3dJbXBvcnRFeHBvcnRFdmVyeXdoZXJlOiBmYWxzZSxcbiAgLy8gV2hlbiBlbmFibGVkLCBoYXNoYmFuZyBkaXJlY3RpdmUgaW4gdGhlIGJlZ2lubmluZyBvZiBmaWxlXG4gIC8vIGlzIGFsbG93ZWQgYW5kIHRyZWF0ZWQgYXMgYSBsaW5lIGNvbW1lbnQuXG4gIGFsbG93SGFzaEJhbmc6IGZhbHNlLFxuICAvLyBXaGVuIGBsb2NhdGlvbnNgIGlzIG9uLCBgbG9jYCBwcm9wZXJ0aWVzIGhvbGRpbmcgb2JqZWN0cyB3aXRoXG4gIC8vIGBzdGFydGAgYW5kIGBlbmRgIHByb3BlcnRpZXMgaW4gYHtsaW5lLCBjb2x1bW59YCBmb3JtICh3aXRoXG4gIC8vIGxpbmUgYmVpbmcgMS1iYXNlZCBhbmQgY29sdW1uIDAtYmFzZWQpIHdpbGwgYmUgYXR0YWNoZWQgdG8gdGhlXG4gIC8vIG5vZGVzLlxuICBsb2NhdGlvbnM6IGZhbHNlLFxuICAvLyBBIGZ1bmN0aW9uIGNhbiBiZSBwYXNzZWQgYXMgYG9uVG9rZW5gIG9wdGlvbiwgd2hpY2ggd2lsbFxuICAvLyBjYXVzZSBBY29ybiB0byBjYWxsIHRoYXQgZnVuY3Rpb24gd2l0aCBvYmplY3QgaW4gdGhlIHNhbWVcbiAgLy8gZm9ybWF0IGFzIHRva2VuaXplKCkgcmV0dXJucy4gTm90ZSB0aGF0IHlvdSBhcmUgbm90XG4gIC8vIGFsbG93ZWQgdG8gY2FsbCB0aGUgcGFyc2VyIGZyb20gdGhlIGNhbGxiYWNr4oCUdGhhdCB3aWxsXG4gIC8vIGNvcnJ1cHQgaXRzIGludGVybmFsIHN0YXRlLlxuICBvblRva2VuOiBudWxsLFxuICAvLyBBIGZ1bmN0aW9uIGNhbiBiZSBwYXNzZWQgYXMgYG9uQ29tbWVudGAgb3B0aW9uLCB3aGljaCB3aWxsXG4gIC8vIGNhdXNlIEFjb3JuIHRvIGNhbGwgdGhhdCBmdW5jdGlvbiB3aXRoIGAoYmxvY2ssIHRleHQsIHN0YXJ0LFxuICAvLyBlbmQpYCBwYXJhbWV0ZXJzIHdoZW5ldmVyIGEgY29tbWVudCBpcyBza2lwcGVkLiBgYmxvY2tgIGlzIGFcbiAgLy8gYm9vbGVhbiBpbmRpY2F0aW5nIHdoZXRoZXIgdGhpcyBpcyBhIGJsb2NrIChgLyogKi9gKSBjb21tZW50LFxuICAvLyBgdGV4dGAgaXMgdGhlIGNvbnRlbnQgb2YgdGhlIGNvbW1lbnQsIGFuZCBgc3RhcnRgIGFuZCBgZW5kYCBhcmVcbiAgLy8gY2hhcmFjdGVyIG9mZnNldHMgdGhhdCBkZW5vdGUgdGhlIHN0YXJ0IGFuZCBlbmQgb2YgdGhlIGNvbW1lbnQuXG4gIC8vIFdoZW4gdGhlIGBsb2NhdGlvbnNgIG9wdGlvbiBpcyBvbiwgdHdvIG1vcmUgcGFyYW1ldGVycyBhcmVcbiAgLy8gcGFzc2VkLCB0aGUgZnVsbCBge2xpbmUsIGNvbHVtbn1gIGxvY2F0aW9ucyBvZiB0aGUgc3RhcnQgYW5kXG4gIC8vIGVuZCBvZiB0aGUgY29tbWVudHMuIE5vdGUgdGhhdCB5b3UgYXJlIG5vdCBhbGxvd2VkIHRvIGNhbGwgdGhlXG4gIC8vIHBhcnNlciBmcm9tIHRoZSBjYWxsYmFja+KAlHRoYXQgd2lsbCBjb3JydXB0IGl0cyBpbnRlcm5hbCBzdGF0ZS5cbiAgb25Db21tZW50OiBudWxsLFxuICAvLyBOb2RlcyBoYXZlIHRoZWlyIHN0YXJ0IGFuZCBlbmQgY2hhcmFjdGVycyBvZmZzZXRzIHJlY29yZGVkIGluXG4gIC8vIGBzdGFydGAgYW5kIGBlbmRgIHByb3BlcnRpZXMgKGRpcmVjdGx5IG9uIHRoZSBub2RlLCByYXRoZXIgdGhhblxuICAvLyB0aGUgYGxvY2Agb2JqZWN0LCB3aGljaCBob2xkcyBsaW5lL2NvbHVtbiBkYXRhLiBUbyBhbHNvIGFkZCBhXG4gIC8vIFtzZW1pLXN0YW5kYXJkaXplZF1bcmFuZ2VdIGByYW5nZWAgcHJvcGVydHkgaG9sZGluZyBhIGBbc3RhcnQsXG4gIC8vIGVuZF1gIGFycmF5IHdpdGggdGhlIHNhbWUgbnVtYmVycywgc2V0IHRoZSBgcmFuZ2VzYCBvcHRpb24gdG9cbiAgLy8gYHRydWVgLlxuICAvL1xuICAvLyBbcmFuZ2VdOiBodHRwczovL2J1Z3ppbGxhLm1vemlsbGEub3JnL3Nob3dfYnVnLmNnaT9pZD03NDU2NzhcbiAgcmFuZ2VzOiBmYWxzZSxcbiAgLy8gSXQgaXMgcG9zc2libGUgdG8gcGFyc2UgbXVsdGlwbGUgZmlsZXMgaW50byBhIHNpbmdsZSBBU1QgYnlcbiAgLy8gcGFzc2luZyB0aGUgdHJlZSBwcm9kdWNlZCBieSBwYXJzaW5nIHRoZSBmaXJzdCBmaWxlIGFzXG4gIC8vIGBwcm9ncmFtYCBvcHRpb24gaW4gc3Vic2VxdWVudCBwYXJzZXMuIFRoaXMgd2lsbCBhZGQgdGhlXG4gIC8vIHRvcGxldmVsIGZvcm1zIG9mIHRoZSBwYXJzZWQgZmlsZSB0byB0aGUgYFByb2dyYW1gICh0b3ApIG5vZGVcbiAgLy8gb2YgYW4gZXhpc3RpbmcgcGFyc2UgdHJlZS5cbiAgcHJvZ3JhbTogbnVsbCxcbiAgLy8gV2hlbiBgbG9jYXRpb25zYCBpcyBvbiwgeW91IGNhbiBwYXNzIHRoaXMgdG8gcmVjb3JkIHRoZSBzb3VyY2VcbiAgLy8gZmlsZSBpbiBldmVyeSBub2RlJ3MgYGxvY2Agb2JqZWN0LlxuICBzb3VyY2VGaWxlOiBudWxsLFxuICAvLyBUaGlzIHZhbHVlLCBpZiBnaXZlbiwgaXMgc3RvcmVkIGluIGV2ZXJ5IG5vZGUsIHdoZXRoZXJcbiAgLy8gYGxvY2F0aW9uc2AgaXMgb24gb3Igb2ZmLlxuICBkaXJlY3RTb3VyY2VGaWxlOiBudWxsLFxuICAvLyBXaGVuIGVuYWJsZWQsIHBhcmVudGhlc2l6ZWQgZXhwcmVzc2lvbnMgYXJlIHJlcHJlc2VudGVkIGJ5XG4gIC8vIChub24tc3RhbmRhcmQpIFBhcmVudGhlc2l6ZWRFeHByZXNzaW9uIG5vZGVzXG4gIHByZXNlcnZlUGFyZW5zOiBmYWxzZSxcbiAgcGx1Z2luczoge31cbn07XG5cbmV4cG9ydHMuZGVmYXVsdE9wdGlvbnMgPSBkZWZhdWx0T3B0aW9ucztcbi8vIEludGVycHJldCBhbmQgZGVmYXVsdCBhbiBvcHRpb25zIG9iamVjdFxuXG5mdW5jdGlvbiBnZXRPcHRpb25zKG9wdHMpIHtcbiAgdmFyIG9wdGlvbnMgPSB7fTtcbiAgZm9yICh2YXIgb3B0IGluIGRlZmF1bHRPcHRpb25zKSB7XG4gICAgb3B0aW9uc1tvcHRdID0gb3B0cyAmJiBfdXRpbC5oYXMob3B0cywgb3B0KSA/IG9wdHNbb3B0XSA6IGRlZmF1bHRPcHRpb25zW29wdF07XG4gIH1pZiAoX3V0aWwuaXNBcnJheShvcHRpb25zLm9uVG9rZW4pKSB7XG4gICAgKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciB0b2tlbnMgPSBvcHRpb25zLm9uVG9rZW47XG4gICAgICBvcHRpb25zLm9uVG9rZW4gPSBmdW5jdGlvbiAodG9rZW4pIHtcbiAgICAgICAgcmV0dXJuIHRva2Vucy5wdXNoKHRva2VuKTtcbiAgICAgIH07XG4gICAgfSkoKTtcbiAgfVxuICBpZiAoX3V0aWwuaXNBcnJheShvcHRpb25zLm9uQ29tbWVudCkpIG9wdGlvbnMub25Db21tZW50ID0gcHVzaENvbW1lbnQob3B0aW9ucywgb3B0aW9ucy5vbkNvbW1lbnQpO1xuXG4gIHJldHVybiBvcHRpb25zO1xufVxuXG5mdW5jdGlvbiBwdXNoQ29tbWVudChvcHRpb25zLCBhcnJheSkge1xuICByZXR1cm4gZnVuY3Rpb24gKGJsb2NrLCB0ZXh0LCBzdGFydCwgZW5kLCBzdGFydExvYywgZW5kTG9jKSB7XG4gICAgdmFyIGNvbW1lbnQgPSB7XG4gICAgICB0eXBlOiBibG9jayA/ICdCbG9jaycgOiAnTGluZScsXG4gICAgICB2YWx1ZTogdGV4dCxcbiAgICAgIHN0YXJ0OiBzdGFydCxcbiAgICAgIGVuZDogZW5kXG4gICAgfTtcbiAgICBpZiAob3B0aW9ucy5sb2NhdGlvbnMpIGNvbW1lbnQubG9jID0gbmV3IF9sb2N1dGlsLlNvdXJjZUxvY2F0aW9uKHRoaXMsIHN0YXJ0TG9jLCBlbmRMb2MpO1xuICAgIGlmIChvcHRpb25zLnJhbmdlcykgY29tbWVudC5yYW5nZSA9IFtzdGFydCwgZW5kXTtcbiAgICBhcnJheS5wdXNoKGNvbW1lbnQpO1xuICB9O1xufVxuXG59LHtcIi4vbG9jdXRpbFwiOjUsXCIuL3V0aWxcIjoxNX1dLDk6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBfdG9rZW50eXBlID0gX2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBfd2hpdGVzcGFjZSA9IF9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7XG5cbnZhciBwcCA9IF9zdGF0ZS5QYXJzZXIucHJvdG90eXBlO1xuXG4vLyAjIyBQYXJzZXIgdXRpbGl0aWVzXG5cbi8vIFRlc3Qgd2hldGhlciBhIHN0YXRlbWVudCBub2RlIGlzIHRoZSBzdHJpbmcgbGl0ZXJhbCBgXCJ1c2Ugc3RyaWN0XCJgLlxuXG5wcC5pc1VzZVN0cmljdCA9IGZ1bmN0aW9uIChzdG10KSB7XG4gIHJldHVybiB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNSAmJiBzdG10LnR5cGUgPT09IFwiRXhwcmVzc2lvblN0YXRlbWVudFwiICYmIHN0bXQuZXhwcmVzc2lvbi50eXBlID09PSBcIkxpdGVyYWxcIiAmJiBzdG10LmV4cHJlc3Npb24ucmF3LnNsaWNlKDEsIC0xKSA9PT0gXCJ1c2Ugc3RyaWN0XCI7XG59O1xuXG4vLyBQcmVkaWNhdGUgdGhhdCB0ZXN0cyB3aGV0aGVyIHRoZSBuZXh0IHRva2VuIGlzIG9mIHRoZSBnaXZlblxuLy8gdHlwZSwgYW5kIGlmIHllcywgY29uc3VtZXMgaXQgYXMgYSBzaWRlIGVmZmVjdC5cblxucHAuZWF0ID0gZnVuY3Rpb24gKHR5cGUpIHtcbiAgaWYgKHRoaXMudHlwZSA9PT0gdHlwZSkge1xuICAgIHRoaXMubmV4dCgpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGVsc2Uge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufTtcblxuLy8gVGVzdHMgd2hldGhlciBwYXJzZWQgdG9rZW4gaXMgYSBjb250ZXh0dWFsIGtleXdvcmQuXG5cbnBwLmlzQ29udGV4dHVhbCA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gIHJldHVybiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSAmJiB0aGlzLnZhbHVlID09PSBuYW1lO1xufTtcblxuLy8gQ29uc3VtZXMgY29udGV4dHVhbCBrZXl3b3JkIGlmIHBvc3NpYmxlLlxuXG5wcC5lYXRDb250ZXh0dWFsID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgcmV0dXJuIHRoaXMudmFsdWUgPT09IG5hbWUgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5uYW1lKTtcbn07XG5cbi8vIEFzc2VydHMgdGhhdCBmb2xsb3dpbmcgdG9rZW4gaXMgZ2l2ZW4gY29udGV4dHVhbCBrZXl3b3JkLlxuXG5wcC5leHBlY3RDb250ZXh0dWFsID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgaWYgKCF0aGlzLmVhdENvbnRleHR1YWwobmFtZSkpIHRoaXMudW5leHBlY3RlZCgpO1xufTtcblxuLy8gVGVzdCB3aGV0aGVyIGEgc2VtaWNvbG9uIGNhbiBiZSBpbnNlcnRlZCBhdCB0aGUgY3VycmVudCBwb3NpdGlvbi5cblxucHAuY2FuSW5zZXJ0U2VtaWNvbG9uID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVvZiB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuYnJhY2VSIHx8IF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0VG9rRW5kLCB0aGlzLnN0YXJ0KSk7XG59O1xuXG5wcC5pbnNlcnRTZW1pY29sb24gPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmNhbkluc2VydFNlbWljb2xvbigpKSB7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5vbkluc2VydGVkU2VtaWNvbG9uKSB0aGlzLm9wdGlvbnMub25JbnNlcnRlZFNlbWljb2xvbih0aGlzLmxhc3RUb2tFbmQsIHRoaXMubGFzdFRva0VuZExvYyk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn07XG5cbi8vIENvbnN1bWUgYSBzZW1pY29sb24sIG9yLCBmYWlsaW5nIHRoYXQsIHNlZSBpZiB3ZSBhcmUgYWxsb3dlZCB0b1xuLy8gcHJldGVuZCB0aGF0IHRoZXJlIGlzIGEgc2VtaWNvbG9uIGF0IHRoaXMgcG9zaXRpb24uXG5cbnBwLnNlbWljb2xvbiA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpICYmICF0aGlzLmluc2VydFNlbWljb2xvbigpKSB0aGlzLnVuZXhwZWN0ZWQoKTtcbn07XG5cbnBwLmFmdGVyVHJhaWxpbmdDb21tYSA9IGZ1bmN0aW9uICh0b2tUeXBlKSB7XG4gIGlmICh0aGlzLnR5cGUgPT0gdG9rVHlwZSkge1xuICAgIGlmICh0aGlzLm9wdGlvbnMub25UcmFpbGluZ0NvbW1hKSB0aGlzLm9wdGlvbnMub25UcmFpbGluZ0NvbW1hKHRoaXMubGFzdFRva1N0YXJ0LCB0aGlzLmxhc3RUb2tTdGFydExvYyk7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn07XG5cbi8vIEV4cGVjdCBhIHRva2VuIG9mIGEgZ2l2ZW4gdHlwZS4gSWYgZm91bmQsIGNvbnN1bWUgaXQsIG90aGVyd2lzZSxcbi8vIHJhaXNlIGFuIHVuZXhwZWN0ZWQgdG9rZW4gZXJyb3IuXG5cbnBwLmV4cGVjdCA9IGZ1bmN0aW9uICh0eXBlKSB7XG4gIHRoaXMuZWF0KHR5cGUpIHx8IHRoaXMudW5leHBlY3RlZCgpO1xufTtcblxuLy8gUmFpc2UgYW4gdW5leHBlY3RlZCB0b2tlbiBlcnJvci5cblxucHAudW5leHBlY3RlZCA9IGZ1bmN0aW9uIChwb3MpIHtcbiAgdGhpcy5yYWlzZShwb3MgIT0gbnVsbCA/IHBvcyA6IHRoaXMuc3RhcnQsIFwiVW5leHBlY3RlZCB0b2tlblwiKTtcbn07XG5cbn0se1wiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTA6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbnZhciBfaWRlbnRpZmllciA9IF9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7XG5cbnZhciBfdG9rZW50eXBlID0gX2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO1xuXG52YXIgX3doaXRlc3BhY2UgPSBfZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO1xuXG52YXIgX29wdGlvbnMgPSBfZGVyZXFfKFwiLi9vcHRpb25zXCIpO1xuXG4vLyBSZWdpc3RlcmVkIHBsdWdpbnNcbnZhciBwbHVnaW5zID0ge307XG5cbmV4cG9ydHMucGx1Z2lucyA9IHBsdWdpbnM7XG5cbnZhciBQYXJzZXIgPSAoZnVuY3Rpb24gKCkge1xuICBmdW5jdGlvbiBQYXJzZXIob3B0aW9ucywgaW5wdXQsIHN0YXJ0UG9zKSB7XG4gICAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFBhcnNlcik7XG5cbiAgICB0aGlzLm9wdGlvbnMgPSBfb3B0aW9ucy5nZXRPcHRpb25zKG9wdGlvbnMpO1xuICAgIHRoaXMuc291cmNlRmlsZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VGaWxlO1xuICAgIHRoaXMuaXNLZXl3b3JkID0gX2lkZW50aWZpZXIua2V5d29yZHNbdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgPyA2IDogNV07XG4gICAgdGhpcy5pc1Jlc2VydmVkV29yZCA9IF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHNbdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uXTtcbiAgICB0aGlzLmlucHV0ID0gU3RyaW5nKGlucHV0KTtcblxuICAgIC8vIFVzZWQgdG8gc2lnbmFsIHRvIGNhbGxlcnMgb2YgYHJlYWRXb3JkMWAgd2hldGhlciB0aGUgd29yZFxuICAgIC8vIGNvbnRhaW5lZCBhbnkgZXNjYXBlIHNlcXVlbmNlcy4gVGhpcyBpcyBuZWVkZWQgYmVjYXVzZSB3b3JkcyB3aXRoXG4gICAgLy8gZXNjYXBlIHNlcXVlbmNlcyBtdXN0IG5vdCBiZSBpbnRlcnByZXRlZCBhcyBrZXl3b3Jkcy5cbiAgICB0aGlzLmNvbnRhaW5zRXNjID0gZmFsc2U7XG5cbiAgICAvLyBMb2FkIHBsdWdpbnNcbiAgICB0aGlzLmxvYWRQbHVnaW5zKHRoaXMub3B0aW9ucy5wbHVnaW5zKTtcblxuICAgIC8vIFNldCB1cCB0b2tlbiBzdGF0ZVxuXG4gICAgLy8gVGhlIGN1cnJlbnQgcG9zaXRpb24gb2YgdGhlIHRva2VuaXplciBpbiB0aGUgaW5wdXQuXG4gICAgaWYgKHN0YXJ0UG9zKSB7XG4gICAgICB0aGlzLnBvcyA9IHN0YXJ0UG9zO1xuICAgICAgdGhpcy5saW5lU3RhcnQgPSBNYXRoLm1heCgwLCB0aGlzLmlucHV0Lmxhc3RJbmRleE9mKFwiXFxuXCIsIHN0YXJ0UG9zKSk7XG4gICAgICB0aGlzLmN1ckxpbmUgPSB0aGlzLmlucHV0LnNsaWNlKDAsIHRoaXMubGluZVN0YXJ0KS5zcGxpdChfd2hpdGVzcGFjZS5saW5lQnJlYWspLmxlbmd0aDtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5wb3MgPSB0aGlzLmxpbmVTdGFydCA9IDA7XG4gICAgICB0aGlzLmN1ckxpbmUgPSAxO1xuICAgIH1cblxuICAgIC8vIFByb3BlcnRpZXMgb2YgdGhlIGN1cnJlbnQgdG9rZW46XG4gICAgLy8gSXRzIHR5cGVcbiAgICB0aGlzLnR5cGUgPSBfdG9rZW50eXBlLnR5cGVzLmVvZjtcbiAgICAvLyBGb3IgdG9rZW5zIHRoYXQgaW5jbHVkZSBtb3JlIGluZm9ybWF0aW9uIHRoYW4gdGhlaXIgdHlwZSwgdGhlIHZhbHVlXG4gICAgdGhpcy52YWx1ZSA9IG51bGw7XG4gICAgLy8gSXRzIHN0YXJ0IGFuZCBlbmQgb2Zmc2V0XG4gICAgdGhpcy5zdGFydCA9IHRoaXMuZW5kID0gdGhpcy5wb3M7XG4gICAgLy8gQW5kLCBpZiBsb2NhdGlvbnMgYXJlIHVzZWQsIHRoZSB7bGluZSwgY29sdW1ufSBvYmplY3RcbiAgICAvLyBjb3JyZXNwb25kaW5nIHRvIHRob3NlIG9mZnNldHNcbiAgICB0aGlzLnN0YXJ0TG9jID0gdGhpcy5lbmRMb2MgPSB0aGlzLmN1clBvc2l0aW9uKCk7XG5cbiAgICAvLyBQb3NpdGlvbiBpbmZvcm1hdGlvbiBmb3IgdGhlIHByZXZpb3VzIHRva2VuXG4gICAgdGhpcy5sYXN0VG9rRW5kTG9jID0gdGhpcy5sYXN0VG9rU3RhcnRMb2MgPSBudWxsO1xuICAgIHRoaXMubGFzdFRva1N0YXJ0ID0gdGhpcy5sYXN0VG9rRW5kID0gdGhpcy5wb3M7XG5cbiAgICAvLyBUaGUgY29udGV4dCBzdGFjayBpcyB1c2VkIHRvIHN1cGVyZmljaWFsbHkgdHJhY2sgc3ludGFjdGljXG4gICAgLy8gY29udGV4dCB0byBwcmVkaWN0IHdoZXRoZXIgYSByZWd1bGFyIGV4cHJlc3Npb24gaXMgYWxsb3dlZCBpbiBhXG4gICAgLy8gZ2l2ZW4gcG9zaXRpb24uXG4gICAgdGhpcy5jb250ZXh0ID0gdGhpcy5pbml0aWFsQ29udGV4dCgpO1xuICAgIHRoaXMuZXhwckFsbG93ZWQgPSB0cnVlO1xuXG4gICAgLy8gRmlndXJlIG91dCBpZiBpdCdzIGEgbW9kdWxlIGNvZGUuXG4gICAgdGhpcy5zdHJpY3QgPSB0aGlzLmluTW9kdWxlID0gdGhpcy5vcHRpb25zLnNvdXJjZVR5cGUgPT09IFwibW9kdWxlXCI7XG5cbiAgICAvLyBVc2VkIHRvIHNpZ25pZnkgdGhlIHN0YXJ0IG9mIGEgcG90ZW50aWFsIGFycm93IGZ1bmN0aW9uXG4gICAgdGhpcy5wb3RlbnRpYWxBcnJvd0F0ID0gLTE7XG5cbiAgICAvLyBGbGFncyB0byB0cmFjayB3aGV0aGVyIHdlIGFyZSBpbiBhIGZ1bmN0aW9uLCBhIGdlbmVyYXRvci5cbiAgICB0aGlzLmluRnVuY3Rpb24gPSB0aGlzLmluR2VuZXJhdG9yID0gZmFsc2U7XG4gICAgLy8gTGFiZWxzIGluIHNjb3BlLlxuICAgIHRoaXMubGFiZWxzID0gW107XG5cbiAgICAvLyBJZiBlbmFibGVkLCBza2lwIGxlYWRpbmcgaGFzaGJhbmcgbGluZS5cbiAgICBpZiAodGhpcy5wb3MgPT09IDAgJiYgdGhpcy5vcHRpb25zLmFsbG93SGFzaEJhbmcgJiYgdGhpcy5pbnB1dC5zbGljZSgwLCAyKSA9PT0gJyMhJykgdGhpcy5za2lwTGluZUNvbW1lbnQoMik7XG4gIH1cblxuICBQYXJzZXIucHJvdG90eXBlLmV4dGVuZCA9IGZ1bmN0aW9uIGV4dGVuZChuYW1lLCBmKSB7XG4gICAgdGhpc1tuYW1lXSA9IGYodGhpc1tuYW1lXSk7XG4gIH07XG5cbiAgUGFyc2VyLnByb3RvdHlwZS5sb2FkUGx1Z2lucyA9IGZ1bmN0aW9uIGxvYWRQbHVnaW5zKHBsdWdpbkNvbmZpZ3MpIHtcbiAgICBmb3IgKHZhciBfbmFtZSBpbiBwbHVnaW5Db25maWdzKSB7XG4gICAgICB2YXIgcGx1Z2luID0gcGx1Z2luc1tfbmFtZV07XG4gICAgICBpZiAoIXBsdWdpbikgdGhyb3cgbmV3IEVycm9yKFwiUGx1Z2luICdcIiArIF9uYW1lICsgXCInIG5vdCBmb3VuZFwiKTtcbiAgICAgIHBsdWdpbih0aGlzLCBwbHVnaW5Db25maWdzW19uYW1lXSk7XG4gICAgfVxuICB9O1xuXG4gIFBhcnNlci5wcm90b3R5cGUucGFyc2UgPSBmdW5jdGlvbiBwYXJzZSgpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMub3B0aW9ucy5wcm9ncmFtIHx8IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgdGhpcy5uZXh0VG9rZW4oKTtcbiAgICByZXR1cm4gdGhpcy5wYXJzZVRvcExldmVsKG5vZGUpO1xuICB9O1xuXG4gIHJldHVybiBQYXJzZXI7XG59KSgpO1xuXG5leHBvcnRzLlBhcnNlciA9IFBhcnNlcjtcblxufSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9vcHRpb25zXCI6OCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDExOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG52YXIgX3Rva2VudHlwZSA9IF9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTtcblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgX3doaXRlc3BhY2UgPSBfZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO1xuXG52YXIgcHAgPSBfc3RhdGUuUGFyc2VyLnByb3RvdHlwZTtcblxuLy8gIyMjIFN0YXRlbWVudCBwYXJzaW5nXG5cbi8vIFBhcnNlIGEgcHJvZ3JhbS4gSW5pdGlhbGl6ZXMgdGhlIHBhcnNlciwgcmVhZHMgYW55IG51bWJlciBvZlxuLy8gc3RhdGVtZW50cywgYW5kIHdyYXBzIHRoZW0gaW4gYSBQcm9ncmFtIG5vZGUuICBPcHRpb25hbGx5IHRha2VzIGFcbi8vIGBwcm9ncmFtYCBhcmd1bWVudC4gIElmIHByZXNlbnQsIHRoZSBzdGF0ZW1lbnRzIHdpbGwgYmUgYXBwZW5kZWRcbi8vIHRvIGl0cyBib2R5IGluc3RlYWQgb2YgY3JlYXRpbmcgYSBuZXcgbm9kZS5cblxucHAucGFyc2VUb3BMZXZlbCA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHZhciBmaXJzdCA9IHRydWU7XG4gIGlmICghbm9kZS5ib2R5KSBub2RlLmJvZHkgPSBbXTtcbiAgd2hpbGUgKHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5lb2YpIHtcbiAgICB2YXIgc3RtdCA9IHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSwgdHJ1ZSk7XG4gICAgbm9kZS5ib2R5LnB1c2goc3RtdCk7XG4gICAgaWYgKGZpcnN0KSB7XG4gICAgICBpZiAodGhpcy5pc1VzZVN0cmljdChzdG10KSkgdGhpcy5zZXRTdHJpY3QodHJ1ZSk7XG4gICAgICBmaXJzdCA9IGZhbHNlO1xuICAgIH1cbiAgfVxuICB0aGlzLm5leHQoKTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgbm9kZS5zb3VyY2VUeXBlID0gdGhpcy5vcHRpb25zLnNvdXJjZVR5cGU7XG4gIH1cbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlByb2dyYW1cIik7XG59O1xuXG52YXIgbG9vcExhYmVsID0geyBraW5kOiBcImxvb3BcIiB9LFxuICAgIHN3aXRjaExhYmVsID0geyBraW5kOiBcInN3aXRjaFwiIH07XG5cbi8vIFBhcnNlIGEgc2luZ2xlIHN0YXRlbWVudC5cbi8vXG4vLyBJZiBleHBlY3RpbmcgYSBzdGF0ZW1lbnQgYW5kIGZpbmRpbmcgYSBzbGFzaCBvcGVyYXRvciwgcGFyc2UgYVxuLy8gcmVndWxhciBleHByZXNzaW9uIGxpdGVyYWwuIFRoaXMgaXMgdG8gaGFuZGxlIGNhc2VzIGxpa2Vcbi8vIGBpZiAoZm9vKSAvYmxhaC8uZXhlYyhmb28pYCwgd2hlcmUgbG9va2luZyBhdCB0aGUgcHJldmlvdXMgdG9rZW5cbi8vIGRvZXMgbm90IGhlbHAuXG5cbnBwLnBhcnNlU3RhdGVtZW50ID0gZnVuY3Rpb24gKGRlY2xhcmF0aW9uLCB0b3BMZXZlbCkge1xuICB2YXIgc3RhcnR0eXBlID0gdGhpcy50eXBlLFxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG5cbiAgLy8gTW9zdCB0eXBlcyBvZiBzdGF0ZW1lbnRzIGFyZSByZWNvZ25pemVkIGJ5IHRoZSBrZXl3b3JkIHRoZXlcbiAgLy8gc3RhcnQgd2l0aC4gTWFueSBhcmUgdHJpdmlhbCB0byBwYXJzZSwgc29tZSByZXF1aXJlIGEgYml0IG9mXG4gIC8vIGNvbXBsZXhpdHkuXG5cbiAgc3dpdGNoIChzdGFydHR5cGUpIHtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2JyZWFrOmNhc2UgX3Rva2VudHlwZS50eXBlcy5fY29udGludWU6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUJyZWFrQ29udGludWVTdGF0ZW1lbnQobm9kZSwgc3RhcnR0eXBlLmtleXdvcmQpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fZGVidWdnZXI6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZURlYnVnZ2VyU3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fZG86XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZURvU3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fZm9yOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VGb3JTdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9mdW5jdGlvbjpcbiAgICAgIGlmICghZGVjbGFyYXRpb24gJiYgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHRoaXMudW5leHBlY3RlZCgpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VGdW5jdGlvblN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2NsYXNzOlxuICAgICAgaWYgKCFkZWNsYXJhdGlvbikgdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUNsYXNzKG5vZGUsIHRydWUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5faWY6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUlmU3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fcmV0dXJuOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VSZXR1cm5TdGF0ZW1lbnQobm9kZSk7XG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl9zd2l0Y2g6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVN3aXRjaFN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3Rocm93OlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VUaHJvd1N0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX3RyeTpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlVHJ5U3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fbGV0OmNhc2UgX3Rva2VudHlwZS50eXBlcy5fY29uc3Q6XG4gICAgICBpZiAoIWRlY2xhcmF0aW9uKSB0aGlzLnVuZXhwZWN0ZWQoKTsgLy8gTk9URTogZmFsbHMgdGhyb3VnaCB0byBfdmFyXG4gICAgY2FzZSBfdG9rZW50eXBlLnR5cGVzLl92YXI6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVZhclN0YXRlbWVudChub2RlLCBzdGFydHR5cGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fd2hpbGU6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZVdoaWxlU3RhdGVtZW50KG5vZGUpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5fd2l0aDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlV2l0aFN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2VMOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VCbG9jaygpO1xuICAgIGNhc2UgX3Rva2VudHlwZS50eXBlcy5zZW1pOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VFbXB0eVN0YXRlbWVudChub2RlKTtcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2V4cG9ydDpcbiAgICBjYXNlIF90b2tlbnR5cGUudHlwZXMuX2ltcG9ydDpcbiAgICAgIGlmICghdGhpcy5vcHRpb25zLmFsbG93SW1wb3J0RXhwb3J0RXZlcnl3aGVyZSkge1xuICAgICAgICBpZiAoIXRvcExldmVsKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiJ2ltcG9ydCcgYW5kICdleHBvcnQnIG1heSBvbmx5IGFwcGVhciBhdCB0aGUgdG9wIGxldmVsXCIpO1xuICAgICAgICBpZiAoIXRoaXMuaW5Nb2R1bGUpIHRoaXMucmFpc2UodGhpcy5zdGFydCwgXCInaW1wb3J0JyBhbmQgJ2V4cG9ydCcgbWF5IGFwcGVhciBvbmx5IHdpdGggJ3NvdXJjZVR5cGU6IG1vZHVsZSdcIik7XG4gICAgICB9XG4gICAgICByZXR1cm4gc3RhcnR0eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pbXBvcnQgPyB0aGlzLnBhcnNlSW1wb3J0KG5vZGUpIDogdGhpcy5wYXJzZUV4cG9ydChub2RlKTtcblxuICAgIC8vIElmIHRoZSBzdGF0ZW1lbnQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHN0YXRlbWVudCBrZXl3b3JkIG9yIGFcbiAgICAvLyBicmFjZSwgaXQncyBhbiBFeHByZXNzaW9uU3RhdGVtZW50IG9yIExhYmVsZWRTdGF0ZW1lbnQuIFdlXG4gICAgLy8gc2ltcGx5IHN0YXJ0IHBhcnNpbmcgYW4gZXhwcmVzc2lvbiwgYW5kIGFmdGVyd2FyZHMsIGlmIHRoZVxuICAgIC8vIG5leHQgdG9rZW4gaXMgYSBjb2xvbiBhbmQgdGhlIGV4cHJlc3Npb24gd2FzIGEgc2ltcGxlXG4gICAgLy8gSWRlbnRpZmllciBub2RlLCB3ZSBzd2l0Y2ggdG8gaW50ZXJwcmV0aW5nIGl0IGFzIGEgbGFiZWwuXG4gICAgZGVmYXVsdDpcbiAgICAgIHZhciBtYXliZU5hbWUgPSB0aGlzLnZhbHVlLFxuICAgICAgICAgIGV4cHIgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgICAgaWYgKHN0YXJ0dHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lICYmIGV4cHIudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb2xvbikpIHJldHVybiB0aGlzLnBhcnNlTGFiZWxlZFN0YXRlbWVudChub2RlLCBtYXliZU5hbWUsIGV4cHIpO2Vsc2UgcmV0dXJuIHRoaXMucGFyc2VFeHByZXNzaW9uU3RhdGVtZW50KG5vZGUsIGV4cHIpO1xuICB9XG59O1xuXG5wcC5wYXJzZUJyZWFrQ29udGludWVTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwga2V5d29yZCkge1xuICB2YXIgaXNCcmVhayA9IGtleXdvcmQgPT0gXCJicmVha1wiO1xuICB0aGlzLm5leHQoKTtcbiAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSkgfHwgdGhpcy5pbnNlcnRTZW1pY29sb24oKSkgbm9kZS5sYWJlbCA9IG51bGw7ZWxzZSBpZiAodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpIHRoaXMudW5leHBlY3RlZCgpO2Vsc2Uge1xuICAgIG5vZGUubGFiZWwgPSB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgICB0aGlzLnNlbWljb2xvbigpO1xuICB9XG5cbiAgLy8gVmVyaWZ5IHRoYXQgdGhlcmUgaXMgYW4gYWN0dWFsIGRlc3RpbmF0aW9uIHRvIGJyZWFrIG9yXG4gIC8vIGNvbnRpbnVlIHRvLlxuICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMubGFiZWxzLmxlbmd0aDsgKytpKSB7XG4gICAgdmFyIGxhYiA9IHRoaXMubGFiZWxzW2ldO1xuICAgIGlmIChub2RlLmxhYmVsID09IG51bGwgfHwgbGFiLm5hbWUgPT09IG5vZGUubGFiZWwubmFtZSkge1xuICAgICAgaWYgKGxhYi5raW5kICE9IG51bGwgJiYgKGlzQnJlYWsgfHwgbGFiLmtpbmQgPT09IFwibG9vcFwiKSkgYnJlYWs7XG4gICAgICBpZiAobm9kZS5sYWJlbCAmJiBpc0JyZWFrKSBicmVhaztcbiAgICB9XG4gIH1cbiAgaWYgKGkgPT09IHRoaXMubGFiZWxzLmxlbmd0aCkgdGhpcy5yYWlzZShub2RlLnN0YXJ0LCBcIlVuc3ludGFjdGljIFwiICsga2V5d29yZCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgaXNCcmVhayA/IFwiQnJlYWtTdGF0ZW1lbnRcIiA6IFwiQ29udGludWVTdGF0ZW1lbnRcIik7XG59O1xuXG5wcC5wYXJzZURlYnVnZ2VyU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHRoaXMuc2VtaWNvbG9uKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJEZWJ1Z2dlclN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlRG9TdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgdGhpcy5sYWJlbHMucHVzaChsb29wTGFiZWwpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTtcbiAgdGhpcy5sYWJlbHMucG9wKCk7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuX3doaWxlKTtcbiAgbm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSk7ZWxzZSB0aGlzLnNlbWljb2xvbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRG9XaGlsZVN0YXRlbWVudFwiKTtcbn07XG5cbi8vIERpc2FtYmlndWF0aW5nIGJldHdlZW4gYSBgZm9yYCBhbmQgYSBgZm9yYC9gaW5gIG9yIGBmb3JgL2BvZmBcbi8vIGxvb3AgaXMgbm9uLXRyaXZpYWwuIEJhc2ljYWxseSwgd2UgaGF2ZSB0byBwYXJzZSB0aGUgaW5pdCBgdmFyYFxuLy8gc3RhdGVtZW50IG9yIGV4cHJlc3Npb24sIGRpc2FsbG93aW5nIHRoZSBgaW5gIG9wZXJhdG9yIChzZWVcbi8vIHRoZSBzZWNvbmQgcGFyYW1ldGVyIHRvIGBwYXJzZUV4cHJlc3Npb25gKSwgYW5kIHRoZW4gY2hlY2tcbi8vIHdoZXRoZXIgdGhlIG5leHQgdG9rZW4gaXMgYGluYCBvciBgb2ZgLiBXaGVuIHRoZXJlIGlzIG5vIGluaXRcbi8vIHBhcnQgKHNlbWljb2xvbiBpbW1lZGlhdGVseSBhZnRlciB0aGUgb3BlbmluZyBwYXJlbnRoZXNpcyksIGl0XG4vLyBpcyBhIHJlZ3VsYXIgYGZvcmAgbG9vcC5cblxucHAucGFyc2VGb3JTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgdGhpcy5sYWJlbHMucHVzaChsb29wTGFiZWwpO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc2VtaSkgcmV0dXJuIHRoaXMucGFyc2VGb3Iobm9kZSwgbnVsbCk7XG4gIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3ZhciB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2xldCB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2NvbnN0KSB7XG4gICAgdmFyIF9pbml0ID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgICAgdmFyS2luZCA9IHRoaXMudHlwZTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICB0aGlzLnBhcnNlVmFyKF9pbml0LCB0cnVlLCB2YXJLaW5kKTtcbiAgICB0aGlzLmZpbmlzaE5vZGUoX2luaXQsIFwiVmFyaWFibGVEZWNsYXJhdGlvblwiKTtcbiAgICBpZiAoKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkgJiYgX2luaXQuZGVjbGFyYXRpb25zLmxlbmd0aCA9PT0gMSAmJiAhKHZhcktpbmQgIT09IF90b2tlbnR5cGUudHlwZXMuX3ZhciAmJiBfaW5pdC5kZWNsYXJhdGlvbnNbMF0uaW5pdCkpIHJldHVybiB0aGlzLnBhcnNlRm9ySW4obm9kZSwgX2luaXQpO1xuICAgIHJldHVybiB0aGlzLnBhcnNlRm9yKG5vZGUsIF9pbml0KTtcbiAgfVxuICB2YXIgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyA9IHsgc3RhcnQ6IDAgfTtcbiAgdmFyIGluaXQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbih0cnVlLCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtcbiAgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkge1xuICAgIHRoaXMudG9Bc3NpZ25hYmxlKGluaXQpO1xuICAgIHRoaXMuY2hlY2tMVmFsKGluaXQpO1xuICAgIHJldHVybiB0aGlzLnBhcnNlRm9ySW4obm9kZSwgaW5pdCk7XG4gIH0gZWxzZSBpZiAocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCkge1xuICAgIHRoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTtcbiAgfVxuICByZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLCBpbml0KTtcbn07XG5cbnBwLnBhcnNlRnVuY3Rpb25TdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgcmV0dXJuIHRoaXMucGFyc2VGdW5jdGlvbihub2RlLCB0cnVlKTtcbn07XG5cbnBwLnBhcnNlSWZTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICBub2RlLmNvbnNlcXVlbnQgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTtcbiAgbm9kZS5hbHRlcm5hdGUgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9lbHNlKSA/IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpIDogbnVsbDtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIklmU3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VSZXR1cm5TdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICBpZiAoIXRoaXMuaW5GdW5jdGlvbiAmJiAhdGhpcy5vcHRpb25zLmFsbG93UmV0dXJuT3V0c2lkZUZ1bmN0aW9uKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiJ3JldHVybicgb3V0c2lkZSBvZiBmdW5jdGlvblwiKTtcbiAgdGhpcy5uZXh0KCk7XG5cbiAgLy8gSW4gYHJldHVybmAgKGFuZCBgYnJlYWtgL2Bjb250aW51ZWApLCB0aGUga2V5d29yZHMgd2l0aFxuICAvLyBvcHRpb25hbCBhcmd1bWVudHMsIHdlIGVhZ2VybHkgbG9vayBmb3IgYSBzZW1pY29sb24gb3IgdGhlXG4gIC8vIHBvc3NpYmlsaXR5IHRvIGluc2VydCBvbmUuXG5cbiAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSkgfHwgdGhpcy5pbnNlcnRTZW1pY29sb24oKSkgbm9kZS5hcmd1bWVudCA9IG51bGw7ZWxzZSB7XG4gICAgbm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5zZW1pY29sb24oKTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiUmV0dXJuU3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VTd2l0Y2hTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5kaXNjcmltaW5hbnQgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gIG5vZGUuY2FzZXMgPSBbXTtcbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO1xuICB0aGlzLmxhYmVscy5wdXNoKHN3aXRjaExhYmVsKTtcblxuICAvLyBTdGF0ZW1lbnRzIHVuZGVyIG11c3QgYmUgZ3JvdXBlZCAoYnkgbGFiZWwpIGluIFN3aXRjaENhc2VcbiAgLy8gbm9kZXMuIGBjdXJgIGlzIHVzZWQgdG8ga2VlcCB0aGUgbm9kZSB0aGF0IHdlIGFyZSBjdXJyZW50bHlcbiAgLy8gYWRkaW5nIHN0YXRlbWVudHMgdG8uXG5cbiAgZm9yICh2YXIgY3VyLCBzYXdEZWZhdWx0ID0gZmFsc2U7IHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlUjspIHtcbiAgICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9jYXNlIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZGVmYXVsdCkge1xuICAgICAgdmFyIGlzQ2FzZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fY2FzZTtcbiAgICAgIGlmIChjdXIpIHRoaXMuZmluaXNoTm9kZShjdXIsIFwiU3dpdGNoQ2FzZVwiKTtcbiAgICAgIG5vZGUuY2FzZXMucHVzaChjdXIgPSB0aGlzLnN0YXJ0Tm9kZSgpKTtcbiAgICAgIGN1ci5jb25zZXF1ZW50ID0gW107XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIGlmIChpc0Nhc2UpIHtcbiAgICAgICAgY3VyLnRlc3QgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKHNhd0RlZmF1bHQpIHRoaXMucmFpc2UodGhpcy5sYXN0VG9rU3RhcnQsIFwiTXVsdGlwbGUgZGVmYXVsdCBjbGF1c2VzXCIpO1xuICAgICAgICBzYXdEZWZhdWx0ID0gdHJ1ZTtcbiAgICAgICAgY3VyLnRlc3QgPSBudWxsO1xuICAgICAgfVxuICAgICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb2xvbik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICghY3VyKSB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICAgIGN1ci5jb25zZXF1ZW50LnB1c2godGhpcy5wYXJzZVN0YXRlbWVudCh0cnVlKSk7XG4gICAgfVxuICB9XG4gIGlmIChjdXIpIHRoaXMuZmluaXNoTm9kZShjdXIsIFwiU3dpdGNoQ2FzZVwiKTtcbiAgdGhpcy5uZXh0KCk7IC8vIENsb3NpbmcgYnJhY2VcbiAgdGhpcy5sYWJlbHMucG9wKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJTd2l0Y2hTdGF0ZW1lbnRcIik7XG59O1xuXG5wcC5wYXJzZVRocm93U3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIGlmIChfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdFRva0VuZCwgdGhpcy5zdGFydCkpKSB0aGlzLnJhaXNlKHRoaXMubGFzdFRva0VuZCwgXCJJbGxlZ2FsIG5ld2xpbmUgYWZ0ZXIgdGhyb3dcIik7XG4gIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICB0aGlzLnNlbWljb2xvbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVGhyb3dTdGF0ZW1lbnRcIik7XG59O1xuXG4vLyBSZXVzZWQgZW1wdHkgYXJyYXkgYWRkZWQgZm9yIG5vZGUgZmllbGRzIHRoYXQgYXJlIGFsd2F5cyBlbXB0eS5cblxudmFyIGVtcHR5ID0gW107XG5cbnBwLnBhcnNlVHJ5U3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIG5vZGUuYmxvY2sgPSB0aGlzLnBhcnNlQmxvY2soKTtcbiAgbm9kZS5oYW5kbGVyID0gbnVsbDtcbiAgaWYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fY2F0Y2gpIHtcbiAgICB2YXIgY2xhdXNlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gICAgY2xhdXNlLnBhcmFtID0gdGhpcy5wYXJzZUJpbmRpbmdBdG9tKCk7XG4gICAgdGhpcy5jaGVja0xWYWwoY2xhdXNlLnBhcmFtLCB0cnVlKTtcbiAgICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7XG4gICAgY2xhdXNlLmd1YXJkID0gbnVsbDtcbiAgICBjbGF1c2UuYm9keSA9IHRoaXMucGFyc2VCbG9jaygpO1xuICAgIG5vZGUuaGFuZGxlciA9IHRoaXMuZmluaXNoTm9kZShjbGF1c2UsIFwiQ2F0Y2hDbGF1c2VcIik7XG4gIH1cbiAgbm9kZS5ndWFyZGVkSGFuZGxlcnMgPSBlbXB0eTtcbiAgbm9kZS5maW5hbGl6ZXIgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9maW5hbGx5KSA/IHRoaXMucGFyc2VCbG9jaygpIDogbnVsbDtcbiAgaWYgKCFub2RlLmhhbmRsZXIgJiYgIW5vZGUuZmluYWxpemVyKSB0aGlzLnJhaXNlKG5vZGUuc3RhcnQsIFwiTWlzc2luZyBjYXRjaCBvciBmaW5hbGx5IGNsYXVzZVwiKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlRyeVN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlVmFyU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIGtpbmQpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIHRoaXMucGFyc2VWYXIobm9kZSwgZmFsc2UsIGtpbmQpO1xuICB0aGlzLnNlbWljb2xvbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVmFyaWFibGVEZWNsYXJhdGlvblwiKTtcbn07XG5cbnBwLnBhcnNlV2hpbGVTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO1xuICB0aGlzLmxhYmVscy5wdXNoKGxvb3BMYWJlbCk7XG4gIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO1xuICB0aGlzLmxhYmVscy5wb3AoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIldoaWxlU3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VXaXRoU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgaWYgKHRoaXMuc3RyaWN0KSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiJ3dpdGgnIGluIHN0cmljdCBtb2RlXCIpO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5vYmplY3QgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiV2l0aFN0YXRlbWVudFwiKTtcbn07XG5cbnBwLnBhcnNlRW1wdHlTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSkge1xuICB0aGlzLm5leHQoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkVtcHR5U3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VMYWJlbGVkU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIG1heWJlTmFtZSwgZXhwcikge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMubGFiZWxzLmxlbmd0aDsgKytpKSB7XG4gICAgaWYgKHRoaXMubGFiZWxzW2ldLm5hbWUgPT09IG1heWJlTmFtZSkgdGhpcy5yYWlzZShleHByLnN0YXJ0LCBcIkxhYmVsICdcIiArIG1heWJlTmFtZSArIFwiJyBpcyBhbHJlYWR5IGRlY2xhcmVkXCIpO1xuICB9dmFyIGtpbmQgPSB0aGlzLnR5cGUuaXNMb29wID8gXCJsb29wXCIgOiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3N3aXRjaCA/IFwic3dpdGNoXCIgOiBudWxsO1xuICBmb3IgKHZhciBpID0gdGhpcy5sYWJlbHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICB2YXIgbGFiZWwgPSB0aGlzLmxhYmVsc1tpXTtcbiAgICBpZiAobGFiZWwuc3RhdGVtZW50U3RhcnQgPT0gbm9kZS5zdGFydCkge1xuICAgICAgbGFiZWwuc3RhdGVtZW50U3RhcnQgPSB0aGlzLnN0YXJ0O1xuICAgICAgbGFiZWwua2luZCA9IGtpbmQ7XG4gICAgfSBlbHNlIGJyZWFrO1xuICB9XG4gIHRoaXMubGFiZWxzLnB1c2goeyBuYW1lOiBtYXliZU5hbWUsIGtpbmQ6IGtpbmQsIHN0YXRlbWVudFN0YXJ0OiB0aGlzLnN0YXJ0IH0pO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KHRydWUpO1xuICB0aGlzLmxhYmVscy5wb3AoKTtcbiAgbm9kZS5sYWJlbCA9IGV4cHI7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJMYWJlbGVkU3RhdGVtZW50XCIpO1xufTtcblxucHAucGFyc2VFeHByZXNzaW9uU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIGV4cHIpIHtcbiAgbm9kZS5leHByZXNzaW9uID0gZXhwcjtcbiAgdGhpcy5zZW1pY29sb24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkV4cHJlc3Npb25TdGF0ZW1lbnRcIik7XG59O1xuXG4vLyBQYXJzZSBhIHNlbWljb2xvbi1lbmNsb3NlZCBibG9jayBvZiBzdGF0ZW1lbnRzLCBoYW5kbGluZyBgXCJ1c2Vcbi8vIHN0cmljdFwiYCBkZWNsYXJhdGlvbnMgd2hlbiBgYWxsb3dTdHJpY3RgIGlzIHRydWUgKHVzZWQgZm9yXG4vLyBmdW5jdGlvbiBib2RpZXMpLlxuXG5wcC5wYXJzZUJsb2NrID0gZnVuY3Rpb24gKGFsbG93U3RyaWN0KSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgIGZpcnN0ID0gdHJ1ZSxcbiAgICAgIG9sZFN0cmljdCA9IHVuZGVmaW5lZDtcbiAgbm9kZS5ib2R5ID0gW107XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKTtcbiAgd2hpbGUgKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtcbiAgICB2YXIgc3RtdCA9IHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSk7XG4gICAgbm9kZS5ib2R5LnB1c2goc3RtdCk7XG4gICAgaWYgKGZpcnN0ICYmIGFsbG93U3RyaWN0ICYmIHRoaXMuaXNVc2VTdHJpY3Qoc3RtdCkpIHtcbiAgICAgIG9sZFN0cmljdCA9IHRoaXMuc3RyaWN0O1xuICAgICAgdGhpcy5zZXRTdHJpY3QodGhpcy5zdHJpY3QgPSB0cnVlKTtcbiAgICB9XG4gICAgZmlyc3QgPSBmYWxzZTtcbiAgfVxuICBpZiAob2xkU3RyaWN0ID09PSBmYWxzZSkgdGhpcy5zZXRTdHJpY3QoZmFsc2UpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQmxvY2tTdGF0ZW1lbnRcIik7XG59O1xuXG4vLyBQYXJzZSBhIHJlZ3VsYXIgYGZvcmAgbG9vcC4gVGhlIGRpc2FtYmlndWF0aW9uIGNvZGUgaW5cbi8vIGBwYXJzZVN0YXRlbWVudGAgd2lsbCBhbHJlYWR5IGhhdmUgcGFyc2VkIHRoZSBpbml0IHN0YXRlbWVudCBvclxuLy8gZXhwcmVzc2lvbi5cblxucHAucGFyc2VGb3IgPSBmdW5jdGlvbiAobm9kZSwgaW5pdCkge1xuICBub2RlLmluaXQgPSBpbml0O1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpO1xuICBub2RlLnRlc3QgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc2VtaSA/IG51bGwgOiB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpO1xuICBub2RlLnVwZGF0ZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5wYXJlblIgPyBudWxsIDogdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTtcbiAgdGhpcy5sYWJlbHMucG9wKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJGb3JTdGF0ZW1lbnRcIik7XG59O1xuXG4vLyBQYXJzZSBhIGBmb3JgL2BpbmAgYW5kIGBmb3JgL2BvZmAgbG9vcCwgd2hpY2ggYXJlIGFsbW9zdFxuLy8gc2FtZSBmcm9tIHBhcnNlcidzIHBlcnNwZWN0aXZlLlxuXG5wcC5wYXJzZUZvckluID0gZnVuY3Rpb24gKG5vZGUsIGluaXQpIHtcbiAgdmFyIHR5cGUgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2luID8gXCJGb3JJblN0YXRlbWVudFwiIDogXCJGb3JPZlN0YXRlbWVudFwiO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5sZWZ0ID0gaW5pdDtcbiAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtcbiAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk7XG4gIHRoaXMubGFiZWxzLnBvcCgpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIHR5cGUpO1xufTtcblxuLy8gUGFyc2UgYSBsaXN0IG9mIHZhcmlhYmxlIGRlY2xhcmF0aW9ucy5cblxucHAucGFyc2VWYXIgPSBmdW5jdGlvbiAobm9kZSwgaXNGb3IsIGtpbmQpIHtcbiAgbm9kZS5kZWNsYXJhdGlvbnMgPSBbXTtcbiAgbm9kZS5raW5kID0ga2luZC5rZXl3b3JkO1xuICBmb3IgKDs7KSB7XG4gICAgdmFyIGRlY2wgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIHRoaXMucGFyc2VWYXJJZChkZWNsKTtcbiAgICBpZiAodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5lcSkpIHtcbiAgICAgIGRlY2wuaW5pdCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihpc0Zvcik7XG4gICAgfSBlbHNlIGlmIChraW5kID09PSBfdG9rZW50eXBlLnR5cGVzLl9jb25zdCAmJiAhKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkpIHtcbiAgICAgIHRoaXMudW5leHBlY3RlZCgpO1xuICAgIH0gZWxzZSBpZiAoZGVjbC5pZC50eXBlICE9IFwiSWRlbnRpZmllclwiICYmICEoaXNGb3IgJiYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkpKSB7XG4gICAgICB0aGlzLnJhaXNlKHRoaXMubGFzdFRva0VuZCwgXCJDb21wbGV4IGJpbmRpbmcgcGF0dGVybnMgcmVxdWlyZSBhbiBpbml0aWFsaXphdGlvbiB2YWx1ZVwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZGVjbC5pbml0ID0gbnVsbDtcbiAgICB9XG4gICAgbm9kZS5kZWNsYXJhdGlvbnMucHVzaCh0aGlzLmZpbmlzaE5vZGUoZGVjbCwgXCJWYXJpYWJsZURlY2xhcmF0b3JcIikpO1xuICAgIGlmICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb21tYSkpIGJyZWFrO1xuICB9XG4gIHJldHVybiBub2RlO1xufTtcblxucHAucGFyc2VWYXJJZCA9IGZ1bmN0aW9uIChkZWNsKSB7XG4gIGRlY2wuaWQgPSB0aGlzLnBhcnNlQmluZGluZ0F0b20oKTtcbiAgdGhpcy5jaGVja0xWYWwoZGVjbC5pZCwgdHJ1ZSk7XG59O1xuXG4vLyBQYXJzZSBhIGZ1bmN0aW9uIGRlY2xhcmF0aW9uIG9yIGxpdGVyYWwgKGRlcGVuZGluZyBvbiB0aGVcbi8vIGBpc1N0YXRlbWVudGAgcGFyYW1ldGVyKS5cblxucHAucGFyc2VGdW5jdGlvbiA9IGZ1bmN0aW9uIChub2RlLCBpc1N0YXRlbWVudCwgYWxsb3dFeHByZXNzaW9uQm9keSkge1xuICB0aGlzLmluaXRGdW5jdGlvbihub2RlKTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSBub2RlLmdlbmVyYXRvciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcik7XG4gIGlmIChpc1N0YXRlbWVudCB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSkgbm9kZS5pZCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICB0aGlzLnBhcnNlRnVuY3Rpb25QYXJhbXMobm9kZSk7XG4gIHRoaXMucGFyc2VGdW5jdGlvbkJvZHkobm9kZSwgYWxsb3dFeHByZXNzaW9uQm9keSk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgaXNTdGF0ZW1lbnQgPyBcIkZ1bmN0aW9uRGVjbGFyYXRpb25cIiA6IFwiRnVuY3Rpb25FeHByZXNzaW9uXCIpO1xufTtcblxucHAucGFyc2VGdW5jdGlvblBhcmFtcyA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKTtcbiAgbm9kZS5wYXJhbXMgPSB0aGlzLnBhcnNlQmluZGluZ0xpc3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIsIGZhbHNlLCBmYWxzZSk7XG59O1xuXG4vLyBQYXJzZSBhIGNsYXNzIGRlY2xhcmF0aW9uIG9yIGxpdGVyYWwgKGRlcGVuZGluZyBvbiB0aGVcbi8vIGBpc1N0YXRlbWVudGAgcGFyYW1ldGVyKS5cblxucHAucGFyc2VDbGFzcyA9IGZ1bmN0aW9uIChub2RlLCBpc1N0YXRlbWVudCkge1xuICB0aGlzLm5leHQoKTtcbiAgdGhpcy5wYXJzZUNsYXNzSWQobm9kZSwgaXNTdGF0ZW1lbnQpO1xuICB0aGlzLnBhcnNlQ2xhc3NTdXBlcihub2RlKTtcbiAgdmFyIGNsYXNzQm9keSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHZhciBoYWRDb25zdHJ1Y3RvciA9IGZhbHNlO1xuICBjbGFzc0JvZHkuYm9keSA9IFtdO1xuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7XG4gIHdoaWxlICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSB7XG4gICAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSkpIGNvbnRpbnVlO1xuICAgIHZhciBtZXRob2QgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIHZhciBpc0dlbmVyYXRvciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcik7XG4gICAgdmFyIGlzTWF5YmVTdGF0aWMgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSAmJiB0aGlzLnZhbHVlID09PSBcInN0YXRpY1wiO1xuICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTtcbiAgICBtZXRob2RbXCJzdGF0aWNcIl0gPSBpc01heWJlU3RhdGljICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5wYXJlbkw7XG4gICAgaWYgKG1ldGhvZFtcInN0YXRpY1wiXSkge1xuICAgICAgaWYgKGlzR2VuZXJhdG9yKSB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICAgIGlzR2VuZXJhdG9yID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTtcbiAgICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTtcbiAgICB9XG4gICAgbWV0aG9kLmtpbmQgPSBcIm1ldGhvZFwiO1xuICAgIHZhciBpc0dldFNldCA9IGZhbHNlO1xuICAgIGlmICghbWV0aG9kLmNvbXB1dGVkKSB7XG4gICAgICB2YXIga2V5ID0gbWV0aG9kLmtleTtcblxuICAgICAgaWYgKCFpc0dlbmVyYXRvciAmJiBrZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCAmJiAoa2V5Lm5hbWUgPT09IFwiZ2V0XCIgfHwga2V5Lm5hbWUgPT09IFwic2V0XCIpKSB7XG4gICAgICAgIGlzR2V0U2V0ID0gdHJ1ZTtcbiAgICAgICAgbWV0aG9kLmtpbmQgPSBrZXkubmFtZTtcbiAgICAgICAga2V5ID0gdGhpcy5wYXJzZVByb3BlcnR5TmFtZShtZXRob2QpO1xuICAgICAgfVxuICAgICAgaWYgKCFtZXRob2RbXCJzdGF0aWNcIl0gJiYgKGtleS50eXBlID09PSBcIklkZW50aWZpZXJcIiAmJiBrZXkubmFtZSA9PT0gXCJjb25zdHJ1Y3RvclwiIHx8IGtleS50eXBlID09PSBcIkxpdGVyYWxcIiAmJiBrZXkudmFsdWUgPT09IFwiY29uc3RydWN0b3JcIikpIHtcbiAgICAgICAgaWYgKGhhZENvbnN0cnVjdG9yKSB0aGlzLnJhaXNlKGtleS5zdGFydCwgXCJEdXBsaWNhdGUgY29uc3RydWN0b3IgaW4gdGhlIHNhbWUgY2xhc3NcIik7XG4gICAgICAgIGlmIChpc0dldFNldCkgdGhpcy5yYWlzZShrZXkuc3RhcnQsIFwiQ29uc3RydWN0b3IgY2FuJ3QgaGF2ZSBnZXQvc2V0IG1vZGlmaWVyXCIpO1xuICAgICAgICBpZiAoaXNHZW5lcmF0b3IpIHRoaXMucmFpc2Uoa2V5LnN0YXJ0LCBcIkNvbnN0cnVjdG9yIGNhbid0IGJlIGEgZ2VuZXJhdG9yXCIpO1xuICAgICAgICBtZXRob2Qua2luZCA9IFwiY29uc3RydWN0b3JcIjtcbiAgICAgICAgaGFkQ29uc3RydWN0b3IgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgICB0aGlzLnBhcnNlQ2xhc3NNZXRob2QoY2xhc3NCb2R5LCBtZXRob2QsIGlzR2VuZXJhdG9yKTtcbiAgICBpZiAoaXNHZXRTZXQpIHtcbiAgICAgIHZhciBwYXJhbUNvdW50ID0gbWV0aG9kLmtpbmQgPT09IFwiZ2V0XCIgPyAwIDogMTtcbiAgICAgIGlmIChtZXRob2QudmFsdWUucGFyYW1zLmxlbmd0aCAhPT0gcGFyYW1Db3VudCkge1xuICAgICAgICB2YXIgc3RhcnQgPSBtZXRob2QudmFsdWUuc3RhcnQ7XG4gICAgICAgIGlmIChtZXRob2Qua2luZCA9PT0gXCJnZXRcIikgdGhpcy5yYWlzZShzdGFydCwgXCJnZXR0ZXIgc2hvdWxkIGhhdmUgbm8gcGFyYW1zXCIpO2Vsc2UgdGhpcy5yYWlzZShzdGFydCwgXCJzZXR0ZXIgc2hvdWxkIGhhdmUgZXhhY3RseSBvbmUgcGFyYW1cIik7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIG5vZGUuYm9keSA9IHRoaXMuZmluaXNoTm9kZShjbGFzc0JvZHksIFwiQ2xhc3NCb2R5XCIpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIGlzU3RhdGVtZW50ID8gXCJDbGFzc0RlY2xhcmF0aW9uXCIgOiBcIkNsYXNzRXhwcmVzc2lvblwiKTtcbn07XG5cbnBwLnBhcnNlQ2xhc3NNZXRob2QgPSBmdW5jdGlvbiAoY2xhc3NCb2R5LCBtZXRob2QsIGlzR2VuZXJhdG9yKSB7XG4gIG1ldGhvZC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoaXNHZW5lcmF0b3IpO1xuICBjbGFzc0JvZHkuYm9keS5wdXNoKHRoaXMuZmluaXNoTm9kZShtZXRob2QsIFwiTWV0aG9kRGVmaW5pdGlvblwiKSk7XG59O1xuXG5wcC5wYXJzZUNsYXNzSWQgPSBmdW5jdGlvbiAobm9kZSwgaXNTdGF0ZW1lbnQpIHtcbiAgbm9kZS5pZCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lID8gdGhpcy5wYXJzZUlkZW50KCkgOiBpc1N0YXRlbWVudCA/IHRoaXMudW5leHBlY3RlZCgpIDogbnVsbDtcbn07XG5cbnBwLnBhcnNlQ2xhc3NTdXBlciA9IGZ1bmN0aW9uIChub2RlKSB7XG4gIG5vZGUuc3VwZXJDbGFzcyA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuX2V4dGVuZHMpID8gdGhpcy5wYXJzZUV4cHJTdWJzY3JpcHRzKCkgOiBudWxsO1xufTtcblxuLy8gUGFyc2VzIG1vZHVsZSBleHBvcnQgZGVjbGFyYXRpb24uXG5cbnBwLnBhcnNlRXhwb3J0ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIC8vIGV4cG9ydCAqIGZyb20gJy4uLidcbiAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3RhcikpIHtcbiAgICB0aGlzLmV4cGVjdENvbnRleHR1YWwoXCJmcm9tXCIpO1xuICAgIG5vZGUuc291cmNlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZyA/IHRoaXMucGFyc2VFeHByQXRvbSgpIDogdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgdGhpcy5zZW1pY29sb24oKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwb3J0QWxsRGVjbGFyYXRpb25cIik7XG4gIH1cbiAgaWYgKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuX2RlZmF1bHQpKSB7XG4gICAgLy8gZXhwb3J0IGRlZmF1bHQgLi4uXG4gICAgdmFyIGV4cHIgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgICB2YXIgbmVlZHNTZW1pID0gdHJ1ZTtcbiAgICBpZiAoZXhwci50eXBlID09IFwiRnVuY3Rpb25FeHByZXNzaW9uXCIgfHwgZXhwci50eXBlID09IFwiQ2xhc3NFeHByZXNzaW9uXCIpIHtcbiAgICAgIG5lZWRzU2VtaSA9IGZhbHNlO1xuICAgICAgaWYgKGV4cHIuaWQpIHtcbiAgICAgICAgZXhwci50eXBlID0gZXhwci50eXBlID09IFwiRnVuY3Rpb25FeHByZXNzaW9uXCIgPyBcIkZ1bmN0aW9uRGVjbGFyYXRpb25cIiA6IFwiQ2xhc3NEZWNsYXJhdGlvblwiO1xuICAgICAgfVxuICAgIH1cbiAgICBub2RlLmRlY2xhcmF0aW9uID0gZXhwcjtcbiAgICBpZiAobmVlZHNTZW1pKSB0aGlzLnNlbWljb2xvbigpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFeHBvcnREZWZhdWx0RGVjbGFyYXRpb25cIik7XG4gIH1cbiAgLy8gZXhwb3J0IHZhcnxjb25zdHxsZXR8ZnVuY3Rpb258Y2xhc3MgLi4uXG4gIGlmICh0aGlzLnNob3VsZFBhcnNlRXhwb3J0U3RhdGVtZW50KCkpIHtcbiAgICBub2RlLmRlY2xhcmF0aW9uID0gdGhpcy5wYXJzZVN0YXRlbWVudCh0cnVlKTtcbiAgICBub2RlLnNwZWNpZmllcnMgPSBbXTtcbiAgICBub2RlLnNvdXJjZSA9IG51bGw7XG4gIH0gZWxzZSB7XG4gICAgLy8gZXhwb3J0IHsgeCwgeSBhcyB6IH0gW2Zyb20gJy4uLiddXG4gICAgbm9kZS5kZWNsYXJhdGlvbiA9IG51bGw7XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gdGhpcy5wYXJzZUV4cG9ydFNwZWNpZmllcnMoKTtcbiAgICBpZiAodGhpcy5lYXRDb250ZXh0dWFsKFwiZnJvbVwiKSkge1xuICAgICAgbm9kZS5zb3VyY2UgPSB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nID8gdGhpcy5wYXJzZUV4cHJBdG9tKCkgOiB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbm9kZS5zb3VyY2UgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLnNlbWljb2xvbigpO1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFeHBvcnROYW1lZERlY2xhcmF0aW9uXCIpO1xufTtcblxucHAuc2hvdWxkUGFyc2VFeHBvcnRTdGF0ZW1lbnQgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLnR5cGUua2V5d29yZDtcbn07XG5cbi8vIFBhcnNlcyBhIGNvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIG1vZHVsZSBleHBvcnRzLlxuXG5wcC5wYXJzZUV4cG9ydFNwZWNpZmllcnMgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlcyA9IFtdLFxuICAgICAgZmlyc3QgPSB0cnVlO1xuICAvLyBleHBvcnQgeyB4LCB5IGFzIHogfSBbZnJvbSAnLi4uJ11cbiAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO1xuICB3aGlsZSAoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge1xuICAgIGlmICghZmlyc3QpIHtcbiAgICAgIHRoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO1xuICAgICAgaWYgKHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkgYnJlYWs7XG4gICAgfSBlbHNlIGZpcnN0ID0gZmFsc2U7XG5cbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgbm9kZS5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2RlZmF1bHQpO1xuICAgIG5vZGUuZXhwb3J0ZWQgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKSA/IHRoaXMucGFyc2VJZGVudCh0cnVlKSA6IG5vZGUubG9jYWw7XG4gICAgbm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJFeHBvcnRTcGVjaWZpZXJcIikpO1xuICB9XG4gIHJldHVybiBub2Rlcztcbn07XG5cbi8vIFBhcnNlcyBpbXBvcnQgZGVjbGFyYXRpb24uXG5cbnBwLnBhcnNlSW1wb3J0ID0gZnVuY3Rpb24gKG5vZGUpIHtcbiAgdGhpcy5uZXh0KCk7XG4gIC8vIGltcG9ydCAnLi4uJ1xuICBpZiAodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZykge1xuICAgIG5vZGUuc3BlY2lmaWVycyA9IGVtcHR5O1xuICAgIG5vZGUuc291cmNlID0gdGhpcy5wYXJzZUV4cHJBdG9tKCk7XG4gIH0gZWxzZSB7XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gdGhpcy5wYXJzZUltcG9ydFNwZWNpZmllcnMoKTtcbiAgICB0aGlzLmV4cGVjdENvbnRleHR1YWwoXCJmcm9tXCIpO1xuICAgIG5vZGUuc291cmNlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZyA/IHRoaXMucGFyc2VFeHByQXRvbSgpIDogdGhpcy51bmV4cGVjdGVkKCk7XG4gIH1cbiAgdGhpcy5zZW1pY29sb24oKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkltcG9ydERlY2xhcmF0aW9uXCIpO1xufTtcblxuLy8gUGFyc2VzIGEgY29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgbW9kdWxlIGltcG9ydHMuXG5cbnBwLnBhcnNlSW1wb3J0U3BlY2lmaWVycyA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGVzID0gW10sXG4gICAgICBmaXJzdCA9IHRydWU7XG4gIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSkge1xuICAgIC8vIGltcG9ydCBkZWZhdWx0T2JqLCB7IHgsIHkgYXMgeiB9IGZyb20gJy4uLidcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgbm9kZS5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICAgIHRoaXMuY2hlY2tMVmFsKG5vZGUubG9jYWwsIHRydWUpO1xuICAgIG5vZGVzLnB1c2godGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiSW1wb3J0RGVmYXVsdFNwZWNpZmllclwiKSk7XG4gICAgaWYgKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKSkgcmV0dXJuIG5vZGVzO1xuICB9XG4gIGlmICh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3Rhcikge1xuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICB0aGlzLmV4cGVjdENvbnRleHR1YWwoXCJhc1wiKTtcbiAgICBub2RlLmxvY2FsID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgdGhpcy5jaGVja0xWYWwobm9kZS5sb2NhbCwgdHJ1ZSk7XG4gICAgbm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJbXBvcnROYW1lc3BhY2VTcGVjaWZpZXJcIikpO1xuICAgIHJldHVybiBub2RlcztcbiAgfVxuICB0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7XG4gIHdoaWxlICghdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSB7XG4gICAgaWYgKCFmaXJzdCkge1xuICAgICAgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7XG4gICAgICBpZiAodGhpcy5hZnRlclRyYWlsaW5nQ29tbWEoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKSBicmVhaztcbiAgICB9IGVsc2UgZmlyc3QgPSBmYWxzZTtcblxuICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICBub2RlLmltcG9ydGVkID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO1xuICAgIG5vZGUubG9jYWwgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKSA/IHRoaXMucGFyc2VJZGVudCgpIDogbm9kZS5pbXBvcnRlZDtcbiAgICB0aGlzLmNoZWNrTFZhbChub2RlLmxvY2FsLCB0cnVlKTtcbiAgICBub2Rlcy5wdXNoKHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkltcG9ydFNwZWNpZmllclwiKSk7XG4gIH1cbiAgcmV0dXJuIG5vZGVzO1xufTtcblxufSx7XCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSwxMjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG4vLyBUaGUgYWxnb3JpdGhtIHVzZWQgdG8gZGV0ZXJtaW5lIHdoZXRoZXIgYSByZWdleHAgY2FuIGFwcGVhciBhdCBhXG4vLyBnaXZlbiBwb2ludCBpbiB0aGUgcHJvZ3JhbSBpcyBsb29zZWx5IGJhc2VkIG9uIHN3ZWV0LmpzJyBhcHByb2FjaC5cbi8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vbW96aWxsYS9zd2VldC5qcy93aWtpL2Rlc2lnblxuXG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpOyB9IH1cblxudmFyIF9zdGF0ZSA9IF9kZXJlcV8oXCIuL3N0YXRlXCIpO1xuXG52YXIgX3Rva2VudHlwZSA9IF9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTtcblxudmFyIF93aGl0ZXNwYWNlID0gX2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTtcblxudmFyIFRva0NvbnRleHQgPSBmdW5jdGlvbiBUb2tDb250ZXh0KHRva2VuLCBpc0V4cHIsIHByZXNlcnZlU3BhY2UsIG92ZXJyaWRlKSB7XG4gIF9jbGFzc0NhbGxDaGVjayh0aGlzLCBUb2tDb250ZXh0KTtcblxuICB0aGlzLnRva2VuID0gdG9rZW47XG4gIHRoaXMuaXNFeHByID0gISFpc0V4cHI7XG4gIHRoaXMucHJlc2VydmVTcGFjZSA9ICEhcHJlc2VydmVTcGFjZTtcbiAgdGhpcy5vdmVycmlkZSA9IG92ZXJyaWRlO1xufTtcblxuZXhwb3J0cy5Ub2tDb250ZXh0ID0gVG9rQ29udGV4dDtcbnZhciB0eXBlcyA9IHtcbiAgYl9zdGF0OiBuZXcgVG9rQ29udGV4dChcIntcIiwgZmFsc2UpLFxuICBiX2V4cHI6IG5ldyBUb2tDb250ZXh0KFwie1wiLCB0cnVlKSxcbiAgYl90bXBsOiBuZXcgVG9rQ29udGV4dChcIiR7XCIsIHRydWUpLFxuICBwX3N0YXQ6IG5ldyBUb2tDb250ZXh0KFwiKFwiLCBmYWxzZSksXG4gIHBfZXhwcjogbmV3IFRva0NvbnRleHQoXCIoXCIsIHRydWUpLFxuICBxX3RtcGw6IG5ldyBUb2tDb250ZXh0KFwiYFwiLCB0cnVlLCB0cnVlLCBmdW5jdGlvbiAocCkge1xuICAgIHJldHVybiBwLnJlYWRUbXBsVG9rZW4oKTtcbiAgfSksXG4gIGZfZXhwcjogbmV3IFRva0NvbnRleHQoXCJmdW5jdGlvblwiLCB0cnVlKVxufTtcblxuZXhwb3J0cy50eXBlcyA9IHR5cGVzO1xudmFyIHBwID0gX3N0YXRlLlBhcnNlci5wcm90b3R5cGU7XG5cbnBwLmluaXRpYWxDb250ZXh0ID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gW3R5cGVzLmJfc3RhdF07XG59O1xuXG5wcC5icmFjZUlzQmxvY2sgPSBmdW5jdGlvbiAocHJldlR5cGUpIHtcbiAgaWYgKHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmNvbG9uKSB7XG4gICAgdmFyIF9wYXJlbnQgPSB0aGlzLmN1ckNvbnRleHQoKTtcbiAgICBpZiAoX3BhcmVudCA9PT0gdHlwZXMuYl9zdGF0IHx8IF9wYXJlbnQgPT09IHR5cGVzLmJfZXhwcikgcmV0dXJuICFfcGFyZW50LmlzRXhwcjtcbiAgfVxuICBpZiAocHJldlR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3JldHVybikgcmV0dXJuIF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0VG9rRW5kLCB0aGlzLnN0YXJ0KSk7XG4gIGlmIChwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZWxzZSB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zZW1pIHx8IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVvZiB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5wYXJlblIpIHJldHVybiB0cnVlO1xuICBpZiAocHJldlR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5icmFjZUwpIHJldHVybiB0aGlzLmN1ckNvbnRleHQoKSA9PT0gdHlwZXMuYl9zdGF0O1xuICByZXR1cm4gIXRoaXMuZXhwckFsbG93ZWQ7XG59O1xuXG5wcC51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKHByZXZUeXBlKSB7XG4gIHZhciB1cGRhdGUgPSB1bmRlZmluZWQsXG4gICAgICB0eXBlID0gdGhpcy50eXBlO1xuICBpZiAodHlwZS5rZXl3b3JkICYmIHByZXZUeXBlID09IF90b2tlbnR5cGUudHlwZXMuZG90KSB0aGlzLmV4cHJBbGxvd2VkID0gZmFsc2U7ZWxzZSBpZiAodXBkYXRlID0gdHlwZS51cGRhdGVDb250ZXh0KSB1cGRhdGUuY2FsbCh0aGlzLCBwcmV2VHlwZSk7ZWxzZSB0aGlzLmV4cHJBbGxvd2VkID0gdHlwZS5iZWZvcmVFeHByO1xufTtcblxuLy8gVG9rZW4tc3BlY2lmaWMgY29udGV4dCB1cGRhdGUgY29kZVxuXG5fdG9rZW50eXBlLnR5cGVzLnBhcmVuUi51cGRhdGVDb250ZXh0ID0gX3Rva2VudHlwZS50eXBlcy5icmFjZVIudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMuY29udGV4dC5sZW5ndGggPT0gMSkge1xuICAgIHRoaXMuZXhwckFsbG93ZWQgPSB0cnVlO1xuICAgIHJldHVybjtcbiAgfVxuICB2YXIgb3V0ID0gdGhpcy5jb250ZXh0LnBvcCgpO1xuICBpZiAob3V0ID09PSB0eXBlcy5iX3N0YXQgJiYgdGhpcy5jdXJDb250ZXh0KCkgPT09IHR5cGVzLmZfZXhwcikge1xuICAgIHRoaXMuY29udGV4dC5wb3AoKTtcbiAgICB0aGlzLmV4cHJBbGxvd2VkID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAob3V0ID09PSB0eXBlcy5iX3RtcGwpIHtcbiAgICB0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmV4cHJBbGxvd2VkID0gIW91dC5pc0V4cHI7XG4gIH1cbn07XG5cbl90b2tlbnR5cGUudHlwZXMuYnJhY2VMLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbiAocHJldlR5cGUpIHtcbiAgdGhpcy5jb250ZXh0LnB1c2godGhpcy5icmFjZUlzQmxvY2socHJldlR5cGUpID8gdHlwZXMuYl9zdGF0IDogdHlwZXMuYl9leHByKTtcbiAgdGhpcy5leHByQWxsb3dlZCA9IHRydWU7XG59O1xuXG5fdG9rZW50eXBlLnR5cGVzLmRvbGxhckJyYWNlTC51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLmNvbnRleHQucHVzaCh0eXBlcy5iX3RtcGwpO1xuICB0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTtcbn07XG5cbl90b2tlbnR5cGUudHlwZXMucGFyZW5MLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbiAocHJldlR5cGUpIHtcbiAgdmFyIHN0YXRlbWVudFBhcmVucyA9IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pZiB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZm9yIHx8IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl93aXRoIHx8IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl93aGlsZTtcbiAgdGhpcy5jb250ZXh0LnB1c2goc3RhdGVtZW50UGFyZW5zID8gdHlwZXMucF9zdGF0IDogdHlwZXMucF9leHByKTtcbiAgdGhpcy5leHByQWxsb3dlZCA9IHRydWU7XG59O1xuXG5fdG9rZW50eXBlLnR5cGVzLmluY0RlYy51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKCkge1xuICAvLyB0b2tFeHByQWxsb3dlZCBzdGF5cyB1bmNoYW5nZWRcbn07XG5cbl90b2tlbnR5cGUudHlwZXMuX2Z1bmN0aW9uLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmN1ckNvbnRleHQoKSAhPT0gdHlwZXMuYl9zdGF0KSB0aGlzLmNvbnRleHQucHVzaCh0eXBlcy5mX2V4cHIpO1xuICB0aGlzLmV4cHJBbGxvd2VkID0gZmFsc2U7XG59O1xuXG5fdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZS51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5jdXJDb250ZXh0KCkgPT09IHR5cGVzLnFfdG1wbCkgdGhpcy5jb250ZXh0LnBvcCgpO2Vsc2UgdGhpcy5jb250ZXh0LnB1c2godHlwZXMucV90bXBsKTtcbiAgdGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO1xufTtcblxufSx7XCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSwxMzpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcblxuZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLCBDb25zdHJ1Y3RvcikgeyBpZiAoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSkgeyB0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpOyB9IH1cblxudmFyIF9pZGVudGlmaWVyID0gX2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTtcblxudmFyIF90b2tlbnR5cGUgPSBfZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF9sb2N1dGlsID0gX2RlcmVxXyhcIi4vbG9jdXRpbFwiKTtcblxudmFyIF93aGl0ZXNwYWNlID0gX2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTtcblxuLy8gT2JqZWN0IHR5cGUgdXNlZCB0byByZXByZXNlbnQgdG9rZW5zLiBOb3RlIHRoYXQgbm9ybWFsbHksIHRva2Vuc1xuLy8gc2ltcGx5IGV4aXN0IGFzIHByb3BlcnRpZXMgb24gdGhlIHBhcnNlciBvYmplY3QuIFRoaXMgaXMgb25seVxuLy8gdXNlZCBmb3IgdGhlIG9uVG9rZW4gY2FsbGJhY2sgYW5kIHRoZSBleHRlcm5hbCB0b2tlbml6ZXIuXG5cbnZhciBUb2tlbiA9IGZ1bmN0aW9uIFRva2VuKHApIHtcbiAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIFRva2VuKTtcblxuICB0aGlzLnR5cGUgPSBwLnR5cGU7XG4gIHRoaXMudmFsdWUgPSBwLnZhbHVlO1xuICB0aGlzLnN0YXJ0ID0gcC5zdGFydDtcbiAgdGhpcy5lbmQgPSBwLmVuZDtcbiAgaWYgKHAub3B0aW9ucy5sb2NhdGlvbnMpIHRoaXMubG9jID0gbmV3IF9sb2N1dGlsLlNvdXJjZUxvY2F0aW9uKHAsIHAuc3RhcnRMb2MsIHAuZW5kTG9jKTtcbiAgaWYgKHAub3B0aW9ucy5yYW5nZXMpIHRoaXMucmFuZ2UgPSBbcC5zdGFydCwgcC5lbmRdO1xufVxuXG4vLyAjIyBUb2tlbml6ZXJcblxuO1xuXG5leHBvcnRzLlRva2VuID0gVG9rZW47XG52YXIgcHAgPSBfc3RhdGUuUGFyc2VyLnByb3RvdHlwZTtcblxuLy8gQXJlIHdlIHJ1bm5pbmcgdW5kZXIgUmhpbm8/XG52YXIgaXNSaGlubyA9IHR5cGVvZiBQYWNrYWdlcyA9PSBcIm9iamVjdFwiICYmIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChQYWNrYWdlcykgPT0gXCJbb2JqZWN0IEphdmFQYWNrYWdlXVwiO1xuXG4vLyBNb3ZlIHRvIHRoZSBuZXh0IHRva2VuXG5cbnBwLm5leHQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLm9wdGlvbnMub25Ub2tlbikgdGhpcy5vcHRpb25zLm9uVG9rZW4obmV3IFRva2VuKHRoaXMpKTtcblxuICB0aGlzLmxhc3RUb2tFbmQgPSB0aGlzLmVuZDtcbiAgdGhpcy5sYXN0VG9rU3RhcnQgPSB0aGlzLnN0YXJ0O1xuICB0aGlzLmxhc3RUb2tFbmRMb2MgPSB0aGlzLmVuZExvYztcbiAgdGhpcy5sYXN0VG9rU3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO1xuICB0aGlzLm5leHRUb2tlbigpO1xufTtcblxucHAuZ2V0VG9rZW4gPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMubmV4dCgpO1xuICByZXR1cm4gbmV3IFRva2VuKHRoaXMpO1xufTtcblxuLy8gSWYgd2UncmUgaW4gYW4gRVM2IGVudmlyb25tZW50LCBtYWtlIHBhcnNlcnMgaXRlcmFibGVcbmlmICh0eXBlb2YgU3ltYm9sICE9PSBcInVuZGVmaW5lZFwiKSBwcFtTeW1ib2wuaXRlcmF0b3JdID0gZnVuY3Rpb24gKCkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHJldHVybiB7IG5leHQ6IGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgICB2YXIgdG9rZW4gPSBzZWxmLmdldFRva2VuKCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBkb25lOiB0b2tlbi50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVvZixcbiAgICAgICAgdmFsdWU6IHRva2VuXG4gICAgICB9O1xuICAgIH0gfTtcbn07XG5cbi8vIFRvZ2dsZSBzdHJpY3QgbW9kZS4gUmUtcmVhZHMgdGhlIG5leHQgbnVtYmVyIG9yIHN0cmluZyB0byBwbGVhc2Vcbi8vIHBlZGFudGljIHRlc3RzIChgXCJ1c2Ugc3RyaWN0XCI7IDAxMDtgIHNob3VsZCBmYWlsKS5cblxucHAuc2V0U3RyaWN0ID0gZnVuY3Rpb24gKHN0cmljdCkge1xuICB0aGlzLnN0cmljdCA9IHN0cmljdDtcbiAgaWYgKHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5udW0gJiYgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZykgcmV0dXJuO1xuICB0aGlzLnBvcyA9IHRoaXMuc3RhcnQ7XG4gIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5saW5lU3RhcnQpIHtcbiAgICAgIHRoaXMubGluZVN0YXJ0ID0gdGhpcy5pbnB1dC5sYXN0SW5kZXhPZihcIlxcblwiLCB0aGlzLmxpbmVTdGFydCAtIDIpICsgMTtcbiAgICAgIC0tdGhpcy5jdXJMaW5lO1xuICAgIH1cbiAgfVxuICB0aGlzLm5leHRUb2tlbigpO1xufTtcblxucHAuY3VyQ29udGV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuY29udGV4dFt0aGlzLmNvbnRleHQubGVuZ3RoIC0gMV07XG59O1xuXG4vLyBSZWFkIGEgc2luZ2xlIHRva2VuLCB1cGRhdGluZyB0aGUgcGFyc2VyIG9iamVjdCdzIHRva2VuLXJlbGF0ZWRcbi8vIHByb3BlcnRpZXMuXG5cbnBwLm5leHRUb2tlbiA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIGN1ckNvbnRleHQgPSB0aGlzLmN1ckNvbnRleHQoKTtcbiAgaWYgKCFjdXJDb250ZXh0IHx8ICFjdXJDb250ZXh0LnByZXNlcnZlU3BhY2UpIHRoaXMuc2tpcFNwYWNlKCk7XG5cbiAgdGhpcy5zdGFydCA9IHRoaXMucG9zO1xuICBpZiAodGhpcy5vcHRpb25zLmxvY2F0aW9ucykgdGhpcy5zdGFydExvYyA9IHRoaXMuY3VyUG9zaXRpb24oKTtcbiAgaWYgKHRoaXMucG9zID49IHRoaXMuaW5wdXQubGVuZ3RoKSByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmVvZik7XG5cbiAgaWYgKGN1ckNvbnRleHQub3ZlcnJpZGUpIHJldHVybiBjdXJDb250ZXh0Lm92ZXJyaWRlKHRoaXMpO2Vsc2UgdGhpcy5yZWFkVG9rZW4odGhpcy5mdWxsQ2hhckNvZGVBdFBvcygpKTtcbn07XG5cbnBwLnJlYWRUb2tlbiA9IGZ1bmN0aW9uIChjb2RlKSB7XG4gIC8vIElkZW50aWZpZXIgb3Iga2V5d29yZC4gJ1xcdVhYWFgnIHNlcXVlbmNlcyBhcmUgYWxsb3dlZCBpblxuICAvLyBpZGVudGlmaWVycywgc28gJ1xcJyBhbHNvIGRpc3BhdGNoZXMgdG8gdGhhdC5cbiAgaWYgKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0KGNvZGUsIHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB8fCBjb2RlID09PSA5MiAvKiAnXFwnICovKSByZXR1cm4gdGhpcy5yZWFkV29yZCgpO1xuXG4gIHJldHVybiB0aGlzLmdldFRva2VuRnJvbUNvZGUoY29kZSk7XG59O1xuXG5wcC5mdWxsQ2hhckNvZGVBdFBvcyA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIGNvZGUgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO1xuICBpZiAoY29kZSA8PSAweGQ3ZmYgfHwgY29kZSA+PSAweGUwMDApIHJldHVybiBjb2RlO1xuICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO1xuICByZXR1cm4gKGNvZGUgPDwgMTApICsgbmV4dCAtIDB4MzVmZGMwMDtcbn07XG5cbnBwLnNraXBCbG9ja0NvbW1lbnQgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzdGFydExvYyA9IHRoaXMub3B0aW9ucy5vbkNvbW1lbnQgJiYgdGhpcy5jdXJQb3NpdGlvbigpO1xuICB2YXIgc3RhcnQgPSB0aGlzLnBvcyxcbiAgICAgIGVuZCA9IHRoaXMuaW5wdXQuaW5kZXhPZihcIiovXCIsIHRoaXMucG9zICs9IDIpO1xuICBpZiAoZW5kID09PSAtMSkgdGhpcy5yYWlzZSh0aGlzLnBvcyAtIDIsIFwiVW50ZXJtaW5hdGVkIGNvbW1lbnRcIik7XG4gIHRoaXMucG9zID0gZW5kICsgMjtcbiAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHtcbiAgICBfd2hpdGVzcGFjZS5saW5lQnJlYWtHLmxhc3RJbmRleCA9IHN0YXJ0O1xuICAgIHZhciBtYXRjaCA9IHVuZGVmaW5lZDtcbiAgICB3aGlsZSAoKG1hdGNoID0gX3doaXRlc3BhY2UubGluZUJyZWFrRy5leGVjKHRoaXMuaW5wdXQpKSAmJiBtYXRjaC5pbmRleCA8IHRoaXMucG9zKSB7XG4gICAgICArK3RoaXMuY3VyTGluZTtcbiAgICAgIHRoaXMubGluZVN0YXJ0ID0gbWF0Y2guaW5kZXggKyBtYXRjaFswXS5sZW5ndGg7XG4gICAgfVxuICB9XG4gIGlmICh0aGlzLm9wdGlvbnMub25Db21tZW50KSB0aGlzLm9wdGlvbnMub25Db21tZW50KHRydWUsIHRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQgKyAyLCBlbmQpLCBzdGFydCwgdGhpcy5wb3MsIHN0YXJ0TG9jLCB0aGlzLmN1clBvc2l0aW9uKCkpO1xufTtcblxucHAuc2tpcExpbmVDb21tZW50ID0gZnVuY3Rpb24gKHN0YXJ0U2tpcCkge1xuICB2YXIgc3RhcnQgPSB0aGlzLnBvcztcbiAgdmFyIHN0YXJ0TG9jID0gdGhpcy5vcHRpb25zLm9uQ29tbWVudCAmJiB0aGlzLmN1clBvc2l0aW9uKCk7XG4gIHZhciBjaCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArPSBzdGFydFNraXApO1xuICB3aGlsZSAodGhpcy5wb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCAmJiBjaCAhPT0gMTAgJiYgY2ggIT09IDEzICYmIGNoICE9PSA4MjMyICYmIGNoICE9PSA4MjMzKSB7XG4gICAgKyt0aGlzLnBvcztcbiAgICBjaCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7XG4gIH1cbiAgaWYgKHRoaXMub3B0aW9ucy5vbkNvbW1lbnQpIHRoaXMub3B0aW9ucy5vbkNvbW1lbnQoZmFsc2UsIHRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQgKyBzdGFydFNraXAsIHRoaXMucG9zKSwgc3RhcnQsIHRoaXMucG9zLCBzdGFydExvYywgdGhpcy5jdXJQb3NpdGlvbigpKTtcbn07XG5cbi8vIENhbGxlZCBhdCB0aGUgc3RhcnQgb2YgdGhlIHBhcnNlIGFuZCBhZnRlciBldmVyeSB0b2tlbi4gU2tpcHNcbi8vIHdoaXRlc3BhY2UgYW5kIGNvbW1lbnRzLCBhbmQuXG5cbnBwLnNraXBTcGFjZSA9IGZ1bmN0aW9uICgpIHtcbiAgbG9vcDogd2hpbGUgKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGgpIHtcbiAgICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO1xuICAgIHN3aXRjaCAoY2gpIHtcbiAgICAgIGNhc2UgMzI6Y2FzZSAxNjA6XG4gICAgICAgIC8vICcgJ1xuICAgICAgICArK3RoaXMucG9zO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMTM6XG4gICAgICAgIGlmICh0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKSA9PT0gMTApIHtcbiAgICAgICAgICArK3RoaXMucG9zO1xuICAgICAgICB9XG4gICAgICBjYXNlIDEwOmNhc2UgODIzMjpjYXNlIDgyMzM6XG4gICAgICAgICsrdGhpcy5wb3M7XG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgICAgICAgKyt0aGlzLmN1ckxpbmU7XG4gICAgICAgICAgdGhpcy5saW5lU3RhcnQgPSB0aGlzLnBvcztcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgNDc6XG4gICAgICAgIC8vICcvJ1xuICAgICAgICBzd2l0Y2ggKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpKSB7XG4gICAgICAgICAgY2FzZSA0MjpcbiAgICAgICAgICAgIC8vICcqJ1xuICAgICAgICAgICAgdGhpcy5za2lwQmxvY2tDb21tZW50KCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlIDQ3OlxuICAgICAgICAgICAgdGhpcy5za2lwTGluZUNvbW1lbnQoMik7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgYnJlYWsgbG9vcDtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIGlmIChjaCA+IDggJiYgY2ggPCAxNCB8fCBjaCA+PSA1NzYwICYmIF93aGl0ZXNwYWNlLm5vbkFTQ0lJd2hpdGVzcGFjZS50ZXN0KFN0cmluZy5mcm9tQ2hhckNvZGUoY2gpKSkge1xuICAgICAgICAgICsrdGhpcy5wb3M7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYnJlYWsgbG9vcDtcbiAgICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuLy8gQ2FsbGVkIGF0IHRoZSBlbmQgb2YgZXZlcnkgdG9rZW4uIFNldHMgYGVuZGAsIGB2YWxgLCBhbmRcbi8vIG1haW50YWlucyBgY29udGV4dGAgYW5kIGBleHByQWxsb3dlZGAsIGFuZCBza2lwcyB0aGUgc3BhY2UgYWZ0ZXJcbi8vIHRoZSB0b2tlbiwgc28gdGhhdCB0aGUgbmV4dCBvbmUncyBgc3RhcnRgIHdpbGwgcG9pbnQgYXQgdGhlXG4vLyByaWdodCBwb3NpdGlvbi5cblxucHAuZmluaXNoVG9rZW4gPSBmdW5jdGlvbiAodHlwZSwgdmFsKSB7XG4gIHRoaXMuZW5kID0gdGhpcy5wb3M7XG4gIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB0aGlzLmVuZExvYyA9IHRoaXMuY3VyUG9zaXRpb24oKTtcbiAgdmFyIHByZXZUeXBlID0gdGhpcy50eXBlO1xuICB0aGlzLnR5cGUgPSB0eXBlO1xuICB0aGlzLnZhbHVlID0gdmFsO1xuXG4gIHRoaXMudXBkYXRlQ29udGV4dChwcmV2VHlwZSk7XG59O1xuXG4vLyAjIyMgVG9rZW4gcmVhZGluZ1xuXG4vLyBUaGlzIGlzIHRoZSBmdW5jdGlvbiB0aGF0IGlzIGNhbGxlZCB0byBmZXRjaCB0aGUgbmV4dCB0b2tlbi4gSXRcbi8vIGlzIHNvbWV3aGF0IG9ic2N1cmUsIGJlY2F1c2UgaXQgd29ya3MgaW4gY2hhcmFjdGVyIGNvZGVzIHJhdGhlclxuLy8gdGhhbiBjaGFyYWN0ZXJzLCBhbmQgYmVjYXVzZSBvcGVyYXRvciBwYXJzaW5nIGhhcyBiZWVuIGlubGluZWRcbi8vIGludG8gaXQuXG4vL1xuLy8gQWxsIGluIHRoZSBuYW1lIG9mIHNwZWVkLlxuLy9cbnBwLnJlYWRUb2tlbl9kb3QgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIGlmIChuZXh0ID49IDQ4ICYmIG5leHQgPD0gNTcpIHJldHVybiB0aGlzLnJlYWROdW1iZXIodHJ1ZSk7XG4gIHZhciBuZXh0MiA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgbmV4dCA9PT0gNDYgJiYgbmV4dDIgPT09IDQ2KSB7XG4gICAgLy8gNDYgPSBkb3QgJy4nXG4gICAgdGhpcy5wb3MgKz0gMztcbiAgICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmVsbGlwc2lzKTtcbiAgfSBlbHNlIHtcbiAgICArK3RoaXMucG9zO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuZG90KTtcbiAgfVxufTtcblxucHAucmVhZFRva2VuX3NsYXNoID0gZnVuY3Rpb24gKCkge1xuICAvLyAnLydcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtcbiAgaWYgKHRoaXMuZXhwckFsbG93ZWQpIHtcbiAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLnJlYWRSZWdleHAoKTtcbiAgfVxuICBpZiAobmV4dCA9PT0gNjEpIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLCAyKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5zbGFzaCwgMSk7XG59O1xuXG5wcC5yZWFkVG9rZW5fbXVsdF9tb2R1bG8gPSBmdW5jdGlvbiAoY29kZSkge1xuICAvLyAnJSonXG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIGlmIChuZXh0ID09PSA2MSkgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sIDIpO1xuICByZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSA0MiA/IF90b2tlbnR5cGUudHlwZXMuc3RhciA6IF90b2tlbnR5cGUudHlwZXMubW9kdWxvLCAxKTtcbn07XG5cbnBwLnJlYWRUb2tlbl9waXBlX2FtcCA9IGZ1bmN0aW9uIChjb2RlKSB7XG4gIC8vICd8JidcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtcbiAgaWYgKG5leHQgPT09IGNvZGUpIHJldHVybiB0aGlzLmZpbmlzaE9wKGNvZGUgPT09IDEyNCA/IF90b2tlbnR5cGUudHlwZXMubG9naWNhbE9SIDogX3Rva2VudHlwZS50eXBlcy5sb2dpY2FsQU5ELCAyKTtcbiAgaWYgKG5leHQgPT09IDYxKSByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbiwgMik7XG4gIHJldHVybiB0aGlzLmZpbmlzaE9wKGNvZGUgPT09IDEyNCA/IF90b2tlbnR5cGUudHlwZXMuYml0d2lzZU9SIDogX3Rva2VudHlwZS50eXBlcy5iaXR3aXNlQU5ELCAxKTtcbn07XG5cbnBwLnJlYWRUb2tlbl9jYXJldCA9IGZ1bmN0aW9uICgpIHtcbiAgLy8gJ14nXG4gIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gIGlmIChuZXh0ID09PSA2MSkgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sIDIpO1xuICByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmJpdHdpc2VYT1IsIDEpO1xufTtcblxucHAucmVhZFRva2VuX3BsdXNfbWluID0gZnVuY3Rpb24gKGNvZGUpIHtcbiAgLy8gJystJ1xuICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO1xuICBpZiAobmV4dCA9PT0gY29kZSkge1xuICAgIGlmIChuZXh0ID09IDQ1ICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09IDYyICYmIF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0VG9rRW5kLCB0aGlzLnBvcykpKSB7XG4gICAgICAvLyBBIGAtLT5gIGxpbmUgY29tbWVudFxuICAgICAgdGhpcy5za2lwTGluZUNvbW1lbnQoMyk7XG4gICAgICB0aGlzLnNraXBTcGFjZSgpO1xuICAgICAgcmV0dXJuIHRoaXMubmV4dFRva2VuKCk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuaW5jRGVjLCAyKTtcbiAgfVxuICBpZiAobmV4dCA9PT0gNjEpIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLCAyKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5wbHVzTWluLCAxKTtcbn07XG5cbnBwLnJlYWRUb2tlbl9sdF9ndCA9IGZ1bmN0aW9uIChjb2RlKSB7XG4gIC8vICc8PidcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtcbiAgdmFyIHNpemUgPSAxO1xuICBpZiAobmV4dCA9PT0gY29kZSkge1xuICAgIHNpemUgPSBjb2RlID09PSA2MiAmJiB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAyKSA9PT0gNjIgPyAzIDogMjtcbiAgICBpZiAodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgc2l6ZSkgPT09IDYxKSByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbiwgc2l6ZSArIDEpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYml0U2hpZnQsIHNpemUpO1xuICB9XG4gIGlmIChuZXh0ID09IDMzICYmIGNvZGUgPT0gNjAgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT0gNDUgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMykgPT0gNDUpIHtcbiAgICBpZiAodGhpcy5pbk1vZHVsZSkgdGhpcy51bmV4cGVjdGVkKCk7XG4gICAgLy8gYDwhLS1gLCBhbiBYTUwtc3R5bGUgY29tbWVudCB0aGF0IHNob3VsZCBiZSBpbnRlcnByZXRlZCBhcyBhIGxpbmUgY29tbWVudFxuICAgIHRoaXMuc2tpcExpbmVDb21tZW50KDQpO1xuICAgIHRoaXMuc2tpcFNwYWNlKCk7XG4gICAgcmV0dXJuIHRoaXMubmV4dFRva2VuKCk7XG4gIH1cbiAgaWYgKG5leHQgPT09IDYxKSBzaXplID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT09IDYxID8gMyA6IDI7XG4gIHJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMucmVsYXRpb25hbCwgc2l6ZSk7XG59O1xuXG5wcC5yZWFkVG9rZW5fZXFfZXhjbCA9IGZ1bmN0aW9uIChjb2RlKSB7XG4gIC8vICc9ISdcbiAgdmFyIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtcbiAgaWYgKG5leHQgPT09IDYxKSByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmVxdWFsaXR5LCB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAyKSA9PT0gNjEgPyAzIDogMik7XG4gIGlmIChjb2RlID09PSA2MSAmJiBuZXh0ID09PSA2MiAmJiB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgIC8vICc9PidcbiAgICB0aGlzLnBvcyArPSAyO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYXJyb3cpO1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaE9wKGNvZGUgPT09IDYxID8gX3Rva2VudHlwZS50eXBlcy5lcSA6IF90b2tlbnR5cGUudHlwZXMucHJlZml4LCAxKTtcbn07XG5cbnBwLmdldFRva2VuRnJvbUNvZGUgPSBmdW5jdGlvbiAoY29kZSkge1xuICBzd2l0Y2ggKGNvZGUpIHtcbiAgICAvLyBUaGUgaW50ZXJwcmV0YXRpb24gb2YgYSBkb3QgZGVwZW5kcyBvbiB3aGV0aGVyIGl0IGlzIGZvbGxvd2VkXG4gICAgLy8gYnkgYSBkaWdpdCBvciBhbm90aGVyIHR3byBkb3RzLlxuICAgIGNhc2UgNDY6XG4gICAgICAvLyAnLidcbiAgICAgIHJldHVybiB0aGlzLnJlYWRUb2tlbl9kb3QoKTtcblxuICAgIC8vIFB1bmN0dWF0aW9uIHRva2Vucy5cbiAgICBjYXNlIDQwOlxuICAgICAgKyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7XG4gICAgY2FzZSA0MTpcbiAgICAgICsrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO1xuICAgIGNhc2UgNTk6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuc2VtaSk7XG4gICAgY2FzZSA0NDpcbiAgICAgICsrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5jb21tYSk7XG4gICAgY2FzZSA5MTpcbiAgICAgICsrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5icmFja2V0TCk7XG4gICAgY2FzZSA5MzpcbiAgICAgICsrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5icmFja2V0Uik7XG4gICAgY2FzZSAxMjM6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKTtcbiAgICBjYXNlIDEyNTpcbiAgICAgICsrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5icmFjZVIpO1xuICAgIGNhc2UgNTg6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuY29sb24pO1xuICAgIGNhc2UgNjM6XG4gICAgICArK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMucXVlc3Rpb24pO1xuXG4gICAgY2FzZSA5NjpcbiAgICAgIC8vICdgJ1xuICAgICAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA8IDYpIGJyZWFrO1xuICAgICAgKyt0aGlzLnBvcztcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlKTtcblxuICAgIGNhc2UgNDg6XG4gICAgICAvLyAnMCdcbiAgICAgIHZhciBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7XG4gICAgICBpZiAobmV4dCA9PT0gMTIwIHx8IG5leHQgPT09IDg4KSByZXR1cm4gdGhpcy5yZWFkUmFkaXhOdW1iZXIoMTYpOyAvLyAnMHgnLCAnMFgnIC0gaGV4IG51bWJlclxuICAgICAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgICAgIGlmIChuZXh0ID09PSAxMTEgfHwgbmV4dCA9PT0gNzkpIHJldHVybiB0aGlzLnJlYWRSYWRpeE51bWJlcig4KTsgLy8gJzBvJywgJzBPJyAtIG9jdGFsIG51bWJlclxuICAgICAgICBpZiAobmV4dCA9PT0gOTggfHwgbmV4dCA9PT0gNjYpIHJldHVybiB0aGlzLnJlYWRSYWRpeE51bWJlcigyKTsgLy8gJzBiJywgJzBCJyAtIGJpbmFyeSBudW1iZXJcbiAgICAgIH1cbiAgICAvLyBBbnl0aGluZyBlbHNlIGJlZ2lubmluZyB3aXRoIGEgZGlnaXQgaXMgYW4gaW50ZWdlciwgb2N0YWxcbiAgICAvLyBudW1iZXIsIG9yIGZsb2F0LlxuICAgIGNhc2UgNDk6Y2FzZSA1MDpjYXNlIDUxOmNhc2UgNTI6Y2FzZSA1MzpjYXNlIDU0OmNhc2UgNTU6Y2FzZSA1NjpjYXNlIDU3OlxuICAgICAgLy8gMS05XG4gICAgICByZXR1cm4gdGhpcy5yZWFkTnVtYmVyKGZhbHNlKTtcblxuICAgIC8vIFF1b3RlcyBwcm9kdWNlIHN0cmluZ3MuXG4gICAgY2FzZSAzNDpjYXNlIDM5OlxuICAgICAgLy8gJ1wiJywgXCInXCJcbiAgICAgIHJldHVybiB0aGlzLnJlYWRTdHJpbmcoY29kZSk7XG5cbiAgICAvLyBPcGVyYXRvcnMgYXJlIHBhcnNlZCBpbmxpbmUgaW4gdGlueSBzdGF0ZSBtYWNoaW5lcy4gJz0nICg2MSkgaXNcbiAgICAvLyBvZnRlbiByZWZlcnJlZCB0by4gYGZpbmlzaE9wYCBzaW1wbHkgc2tpcHMgdGhlIGFtb3VudCBvZlxuICAgIC8vIGNoYXJhY3RlcnMgaXQgaXMgZ2l2ZW4gYXMgc2Vjb25kIGFyZ3VtZW50LCBhbmQgcmV0dXJucyBhIHRva2VuXG4gICAgLy8gb2YgdGhlIHR5cGUgZ2l2ZW4gYnkgaXRzIGZpcnN0IGFyZ3VtZW50LlxuXG4gICAgY2FzZSA0NzpcbiAgICAgIC8vICcvJ1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX3NsYXNoKCk7XG5cbiAgICBjYXNlIDM3OmNhc2UgNDI6XG4gICAgICAvLyAnJSonXG4gICAgICByZXR1cm4gdGhpcy5yZWFkVG9rZW5fbXVsdF9tb2R1bG8oY29kZSk7XG5cbiAgICBjYXNlIDEyNDpjYXNlIDM4OlxuICAgICAgLy8gJ3wmJ1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX3BpcGVfYW1wKGNvZGUpO1xuXG4gICAgY2FzZSA5NDpcbiAgICAgIC8vICdeJ1xuICAgICAgcmV0dXJuIHRoaXMucmVhZFRva2VuX2NhcmV0KCk7XG5cbiAgICBjYXNlIDQzOmNhc2UgNDU6XG4gICAgICAvLyAnKy0nXG4gICAgICByZXR1cm4gdGhpcy5yZWFkVG9rZW5fcGx1c19taW4oY29kZSk7XG5cbiAgICBjYXNlIDYwOmNhc2UgNjI6XG4gICAgICAvLyAnPD4nXG4gICAgICByZXR1cm4gdGhpcy5yZWFkVG9rZW5fbHRfZ3QoY29kZSk7XG5cbiAgICBjYXNlIDYxOmNhc2UgMzM6XG4gICAgICAvLyAnPSEnXG4gICAgICByZXR1cm4gdGhpcy5yZWFkVG9rZW5fZXFfZXhjbChjb2RlKTtcblxuICAgIGNhc2UgMTI2OlxuICAgICAgLy8gJ34nXG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLnByZWZpeCwgMSk7XG4gIH1cblxuICB0aGlzLnJhaXNlKHRoaXMucG9zLCBcIlVuZXhwZWN0ZWQgY2hhcmFjdGVyICdcIiArIGNvZGVQb2ludFRvU3RyaW5nKGNvZGUpICsgXCInXCIpO1xufTtcblxucHAuZmluaXNoT3AgPSBmdW5jdGlvbiAodHlwZSwgc2l6ZSkge1xuICB2YXIgc3RyID0gdGhpcy5pbnB1dC5zbGljZSh0aGlzLnBvcywgdGhpcy5wb3MgKyBzaXplKTtcbiAgdGhpcy5wb3MgKz0gc2l6ZTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoVG9rZW4odHlwZSwgc3RyKTtcbn07XG5cbi8vIFBhcnNlIGEgcmVndWxhciBleHByZXNzaW9uLiBTb21lIGNvbnRleHQtYXdhcmVuZXNzIGlzIG5lY2Vzc2FyeSxcbi8vIHNpbmNlIGEgJy8nIGluc2lkZSBhICdbXScgc2V0IGRvZXMgbm90IGVuZCB0aGUgZXhwcmVzc2lvbi5cblxuZnVuY3Rpb24gdHJ5Q3JlYXRlUmVnZXhwKHNyYywgZmxhZ3MsIHRocm93RXJyb3JBdCkge1xuICB0cnkge1xuICAgIHJldHVybiBuZXcgUmVnRXhwKHNyYywgZmxhZ3MpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKHRocm93RXJyb3JBdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoZSBpbnN0YW5jZW9mIFN5bnRheEVycm9yKSB0aGlzLnJhaXNlKHRocm93RXJyb3JBdCwgXCJFcnJvciBwYXJzaW5nIHJlZ3VsYXIgZXhwcmVzc2lvbjogXCIgKyBlLm1lc3NhZ2UpO1xuICAgICAgdGhpcy5yYWlzZShlKTtcbiAgICB9XG4gIH1cbn1cblxudmFyIHJlZ2V4cFVuaWNvZGVTdXBwb3J0ID0gISF0cnlDcmVhdGVSZWdleHAoXCLvv79cIiwgXCJ1XCIpO1xuXG5wcC5yZWFkUmVnZXhwID0gZnVuY3Rpb24gKCkge1xuICB2YXIgX3RoaXMgPSB0aGlzO1xuXG4gIHZhciBlc2NhcGVkID0gdW5kZWZpbmVkLFxuICAgICAgaW5DbGFzcyA9IHVuZGVmaW5lZCxcbiAgICAgIHN0YXJ0ID0gdGhpcy5wb3M7XG4gIGZvciAoOzspIHtcbiAgICBpZiAodGhpcy5wb3MgPj0gdGhpcy5pbnB1dC5sZW5ndGgpIHRoaXMucmFpc2Uoc3RhcnQsIFwiVW50ZXJtaW5hdGVkIHJlZ3VsYXIgZXhwcmVzc2lvblwiKTtcbiAgICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJBdCh0aGlzLnBvcyk7XG4gICAgaWYgKF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KGNoKSkgdGhpcy5yYWlzZShzdGFydCwgXCJVbnRlcm1pbmF0ZWQgcmVndWxhciBleHByZXNzaW9uXCIpO1xuICAgIGlmICghZXNjYXBlZCkge1xuICAgICAgaWYgKGNoID09PSBcIltcIikgaW5DbGFzcyA9IHRydWU7ZWxzZSBpZiAoY2ggPT09IFwiXVwiICYmIGluQ2xhc3MpIGluQ2xhc3MgPSBmYWxzZTtlbHNlIGlmIChjaCA9PT0gXCIvXCIgJiYgIWluQ2xhc3MpIGJyZWFrO1xuICAgICAgZXNjYXBlZCA9IGNoID09PSBcIlxcXFxcIjtcbiAgICB9IGVsc2UgZXNjYXBlZCA9IGZhbHNlO1xuICAgICsrdGhpcy5wb3M7XG4gIH1cbiAgdmFyIGNvbnRlbnQgPSB0aGlzLmlucHV0LnNsaWNlKHN0YXJ0LCB0aGlzLnBvcyk7XG4gICsrdGhpcy5wb3M7XG4gIC8vIE5lZWQgdG8gdXNlIGByZWFkV29yZDFgIGJlY2F1c2UgJ1xcdVhYWFgnIHNlcXVlbmNlcyBhcmUgYWxsb3dlZFxuICAvLyBoZXJlIChkb24ndCBhc2spLlxuICB2YXIgbW9kcyA9IHRoaXMucmVhZFdvcmQxKCk7XG4gIHZhciB0bXAgPSBjb250ZW50O1xuICBpZiAobW9kcykge1xuICAgIHZhciB2YWxpZEZsYWdzID0gL15bZ21zaXldKiQvO1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikgdmFsaWRGbGFncyA9IC9eW2dtc2l5dV0qJC87XG4gICAgaWYgKCF2YWxpZEZsYWdzLnRlc3QobW9kcykpIHRoaXMucmFpc2Uoc3RhcnQsIFwiSW52YWxpZCByZWd1bGFyIGV4cHJlc3Npb24gZmxhZ1wiKTtcbiAgICBpZiAobW9kcy5pbmRleE9mKCd1JykgPj0gMCAmJiAhcmVnZXhwVW5pY29kZVN1cHBvcnQpIHtcbiAgICAgIC8vIFJlcGxhY2UgZWFjaCBhc3RyYWwgc3ltYm9sIGFuZCBldmVyeSBVbmljb2RlIGVzY2FwZSBzZXF1ZW5jZSB0aGF0XG4gICAgICAvLyBwb3NzaWJseSByZXByZXNlbnRzIGFuIGFzdHJhbCBzeW1ib2wgb3IgYSBwYWlyZWQgc3Vycm9nYXRlIHdpdGggYVxuICAgICAgLy8gc2luZ2xlIEFTQ0lJIHN5bWJvbCB0byBhdm9pZCB0aHJvd2luZyBvbiByZWd1bGFyIGV4cHJlc3Npb25zIHRoYXRcbiAgICAgIC8vIGFyZSBvbmx5IHZhbGlkIGluIGNvbWJpbmF0aW9uIHdpdGggdGhlIGAvdWAgZmxhZy5cbiAgICAgIC8vIE5vdGU6IHJlcGxhY2luZyB3aXRoIHRoZSBBU0NJSSBzeW1ib2wgYHhgIG1pZ2h0IGNhdXNlIGZhbHNlXG4gICAgICAvLyBuZWdhdGl2ZXMgaW4gdW5saWtlbHkgc2NlbmFyaW9zLiBGb3IgZXhhbXBsZSwgYFtcXHV7NjF9LWJdYCBpcyBhXG4gICAgICAvLyBwZXJmZWN0bHkgdmFsaWQgcGF0dGVybiB0aGF0IGlzIGVxdWl2YWxlbnQgdG8gYFthLWJdYCwgYnV0IGl0IHdvdWxkXG4gICAgICAvLyBiZSByZXBsYWNlZCBieSBgW3gtYl1gIHdoaWNoIHRocm93cyBhbiBlcnJvci5cbiAgICAgIHRtcCA9IHRtcC5yZXBsYWNlKC9cXFxcdVxceyhbMC05YS1mQS1GXSspXFx9L2csIGZ1bmN0aW9uIChtYXRjaCwgY29kZSwgb2Zmc2V0KSB7XG4gICAgICAgIGNvZGUgPSBOdW1iZXIoXCIweFwiICsgY29kZSk7XG4gICAgICAgIGlmIChjb2RlID4gMHgxMEZGRkYpIF90aGlzLnJhaXNlKHN0YXJ0ICsgb2Zmc2V0ICsgMywgXCJDb2RlIHBvaW50IG91dCBvZiBib3VuZHNcIik7XG4gICAgICAgIHJldHVybiBcInhcIjtcbiAgICAgIH0pO1xuICAgICAgdG1wID0gdG1wLnJlcGxhY2UoL1xcXFx1KFthLWZBLUYwLTldezR9KXxbXFx1RDgwMC1cXHVEQkZGXVtcXHVEQzAwLVxcdURGRkZdL2csIFwieFwiKTtcbiAgICB9XG4gIH1cbiAgLy8gRGV0ZWN0IGludmFsaWQgcmVndWxhciBleHByZXNzaW9ucy5cbiAgdmFyIHZhbHVlID0gbnVsbDtcbiAgLy8gUmhpbm8ncyByZWd1bGFyIGV4cHJlc3Npb24gcGFyc2VyIGlzIGZsYWt5IGFuZCB0aHJvd3MgdW5jYXRjaGFibGUgZXhjZXB0aW9ucyxcbiAgLy8gc28gZG9uJ3QgZG8gZGV0ZWN0aW9uIGlmIHdlIGFyZSBydW5uaW5nIHVuZGVyIFJoaW5vXG4gIGlmICghaXNSaGlubykge1xuICAgIHRyeUNyZWF0ZVJlZ2V4cCh0bXAsIHVuZGVmaW5lZCwgc3RhcnQpO1xuICAgIC8vIEdldCBhIHJlZ3VsYXIgZXhwcmVzc2lvbiBvYmplY3QgZm9yIHRoaXMgcGF0dGVybi1mbGFnIHBhaXIsIG9yIGBudWxsYCBpblxuICAgIC8vIGNhc2UgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgZG9lc24ndCBzdXBwb3J0IHRoZSBmbGFncyBpdCB1c2VzLlxuICAgIHZhbHVlID0gdHJ5Q3JlYXRlUmVnZXhwKGNvbnRlbnQsIG1vZHMpO1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMucmVnZXhwLCB7IHBhdHRlcm46IGNvbnRlbnQsIGZsYWdzOiBtb2RzLCB2YWx1ZTogdmFsdWUgfSk7XG59O1xuXG4vLyBSZWFkIGFuIGludGVnZXIgaW4gdGhlIGdpdmVuIHJhZGl4LiBSZXR1cm4gbnVsbCBpZiB6ZXJvIGRpZ2l0c1xuLy8gd2VyZSByZWFkLCB0aGUgaW50ZWdlciB2YWx1ZSBvdGhlcndpc2UuIFdoZW4gYGxlbmAgaXMgZ2l2ZW4sIHRoaXNcbi8vIHdpbGwgcmV0dXJuIGBudWxsYCB1bmxlc3MgdGhlIGludGVnZXIgaGFzIGV4YWN0bHkgYGxlbmAgZGlnaXRzLlxuXG5wcC5yZWFkSW50ID0gZnVuY3Rpb24gKHJhZGl4LCBsZW4pIHtcbiAgdmFyIHN0YXJ0ID0gdGhpcy5wb3MsXG4gICAgICB0b3RhbCA9IDA7XG4gIGZvciAodmFyIGkgPSAwLCBlID0gbGVuID09IG51bGwgPyBJbmZpbml0eSA6IGxlbjsgaSA8IGU7ICsraSkge1xuICAgIHZhciBjb2RlID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSxcbiAgICAgICAgdmFsID0gdW5kZWZpbmVkO1xuICAgIGlmIChjb2RlID49IDk3KSB2YWwgPSBjb2RlIC0gOTcgKyAxMDsgLy8gYVxuICAgIGVsc2UgaWYgKGNvZGUgPj0gNjUpIHZhbCA9IGNvZGUgLSA2NSArIDEwOyAvLyBBXG4gICAgICBlbHNlIGlmIChjb2RlID49IDQ4ICYmIGNvZGUgPD0gNTcpIHZhbCA9IGNvZGUgLSA0ODsgLy8gMC05XG4gICAgICAgIGVsc2UgdmFsID0gSW5maW5pdHk7XG4gICAgaWYgKHZhbCA+PSByYWRpeCkgYnJlYWs7XG4gICAgKyt0aGlzLnBvcztcbiAgICB0b3RhbCA9IHRvdGFsICogcmFkaXggKyB2YWw7XG4gIH1cbiAgaWYgKHRoaXMucG9zID09PSBzdGFydCB8fCBsZW4gIT0gbnVsbCAmJiB0aGlzLnBvcyAtIHN0YXJ0ICE9PSBsZW4pIHJldHVybiBudWxsO1xuXG4gIHJldHVybiB0b3RhbDtcbn07XG5cbnBwLnJlYWRSYWRpeE51bWJlciA9IGZ1bmN0aW9uIChyYWRpeCkge1xuICB0aGlzLnBvcyArPSAyOyAvLyAweFxuICB2YXIgdmFsID0gdGhpcy5yZWFkSW50KHJhZGl4KTtcbiAgaWYgKHZhbCA9PSBudWxsKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQgKyAyLCBcIkV4cGVjdGVkIG51bWJlciBpbiByYWRpeCBcIiArIHJhZGl4KTtcbiAgaWYgKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0KHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKSkpIHRoaXMucmFpc2UodGhpcy5wb3MsIFwiSWRlbnRpZmllciBkaXJlY3RseSBhZnRlciBudW1iZXJcIik7XG4gIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMubnVtLCB2YWwpO1xufTtcblxuLy8gUmVhZCBhbiBpbnRlZ2VyLCBvY3RhbCBpbnRlZ2VyLCBvciBmbG9hdGluZy1wb2ludCBudW1iZXIuXG5cbnBwLnJlYWROdW1iZXIgPSBmdW5jdGlvbiAoc3RhcnRzV2l0aERvdCkge1xuICB2YXIgc3RhcnQgPSB0aGlzLnBvcyxcbiAgICAgIGlzRmxvYXQgPSBmYWxzZSxcbiAgICAgIG9jdGFsID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSA9PT0gNDg7XG4gIGlmICghc3RhcnRzV2l0aERvdCAmJiB0aGlzLnJlYWRJbnQoMTApID09PSBudWxsKSB0aGlzLnJhaXNlKHN0YXJ0LCBcIkludmFsaWQgbnVtYmVyXCIpO1xuICB2YXIgbmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7XG4gIGlmIChuZXh0ID09PSA0Nikge1xuICAgIC8vICcuJ1xuICAgICsrdGhpcy5wb3M7XG4gICAgdGhpcy5yZWFkSW50KDEwKTtcbiAgICBpc0Zsb2F0ID0gdHJ1ZTtcbiAgICBuZXh0ID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtcbiAgfVxuICBpZiAobmV4dCA9PT0gNjkgfHwgbmV4dCA9PT0gMTAxKSB7XG4gICAgLy8gJ2VFJ1xuICAgIG5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQoKyt0aGlzLnBvcyk7XG4gICAgaWYgKG5leHQgPT09IDQzIHx8IG5leHQgPT09IDQ1KSArK3RoaXMucG9zOyAvLyAnKy0nXG4gICAgaWYgKHRoaXMucmVhZEludCgxMCkgPT09IG51bGwpIHRoaXMucmFpc2Uoc3RhcnQsIFwiSW52YWxpZCBudW1iZXJcIik7XG4gICAgaXNGbG9hdCA9IHRydWU7XG4gIH1cbiAgaWYgKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0KHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKSkpIHRoaXMucmFpc2UodGhpcy5wb3MsIFwiSWRlbnRpZmllciBkaXJlY3RseSBhZnRlciBudW1iZXJcIik7XG5cbiAgdmFyIHN0ciA9IHRoaXMuaW5wdXQuc2xpY2Uoc3RhcnQsIHRoaXMucG9zKSxcbiAgICAgIHZhbCA9IHVuZGVmaW5lZDtcbiAgaWYgKGlzRmxvYXQpIHZhbCA9IHBhcnNlRmxvYXQoc3RyKTtlbHNlIGlmICghb2N0YWwgfHwgc3RyLmxlbmd0aCA9PT0gMSkgdmFsID0gcGFyc2VJbnQoc3RyLCAxMCk7ZWxzZSBpZiAoL1s4OV0vLnRlc3Qoc3RyKSB8fCB0aGlzLnN0cmljdCkgdGhpcy5yYWlzZShzdGFydCwgXCJJbnZhbGlkIG51bWJlclwiKTtlbHNlIHZhbCA9IHBhcnNlSW50KHN0ciwgOCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMubnVtLCB2YWwpO1xufTtcblxuLy8gUmVhZCBhIHN0cmluZyB2YWx1ZSwgaW50ZXJwcmV0aW5nIGJhY2tzbGFzaC1lc2NhcGVzLlxuXG5wcC5yZWFkQ29kZVBvaW50ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpLFxuICAgICAgY29kZSA9IHVuZGVmaW5lZDtcblxuICBpZiAoY2ggPT09IDEyMykge1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPCA2KSB0aGlzLnVuZXhwZWN0ZWQoKTtcbiAgICB2YXIgY29kZVBvcyA9ICsrdGhpcy5wb3M7XG4gICAgY29kZSA9IHRoaXMucmVhZEhleENoYXIodGhpcy5pbnB1dC5pbmRleE9mKCd9JywgdGhpcy5wb3MpIC0gdGhpcy5wb3MpO1xuICAgICsrdGhpcy5wb3M7XG4gICAgaWYgKGNvZGUgPiAweDEwRkZGRikgdGhpcy5yYWlzZShjb2RlUG9zLCBcIkNvZGUgcG9pbnQgb3V0IG9mIGJvdW5kc1wiKTtcbiAgfSBlbHNlIHtcbiAgICBjb2RlID0gdGhpcy5yZWFkSGV4Q2hhcig0KTtcbiAgfVxuICByZXR1cm4gY29kZTtcbn07XG5cbmZ1bmN0aW9uIGNvZGVQb2ludFRvU3RyaW5nKGNvZGUpIHtcbiAgLy8gVVRGLTE2IERlY29kaW5nXG4gIGlmIChjb2RlIDw9IDB4RkZGRikgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoY29kZSk7XG4gIGNvZGUgLT0gMHgxMDAwMDtcbiAgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoKGNvZGUgPj4gMTApICsgMHhEODAwLCAoY29kZSAmIDEwMjMpICsgMHhEQzAwKTtcbn1cblxucHAucmVhZFN0cmluZyA9IGZ1bmN0aW9uIChxdW90ZSkge1xuICB2YXIgb3V0ID0gXCJcIixcbiAgICAgIGNodW5rU3RhcnQgPSArK3RoaXMucG9zO1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKHRoaXMucG9zID49IHRoaXMuaW5wdXQubGVuZ3RoKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiVW50ZXJtaW5hdGVkIHN0cmluZyBjb25zdGFudFwiKTtcbiAgICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO1xuICAgIGlmIChjaCA9PT0gcXVvdGUpIGJyZWFrO1xuICAgIGlmIChjaCA9PT0gOTIpIHtcbiAgICAgIC8vICdcXCdcbiAgICAgIG91dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKTtcbiAgICAgIG91dCArPSB0aGlzLnJlYWRFc2NhcGVkQ2hhcihmYWxzZSk7XG4gICAgICBjaHVua1N0YXJ0ID0gdGhpcy5wb3M7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmIChfd2hpdGVzcGFjZS5pc05ld0xpbmUoY2gpKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiVW50ZXJtaW5hdGVkIHN0cmluZyBjb25zdGFudFwiKTtcbiAgICAgICsrdGhpcy5wb3M7XG4gICAgfVxuICB9XG4gIG91dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKyspO1xuICByZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnN0cmluZywgb3V0KTtcbn07XG5cbi8vIFJlYWRzIHRlbXBsYXRlIHN0cmluZyB0b2tlbnMuXG5cbnBwLnJlYWRUbXBsVG9rZW4gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBvdXQgPSBcIlwiLFxuICAgICAgY2h1bmtTdGFydCA9IHRoaXMucG9zO1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKHRoaXMucG9zID49IHRoaXMuaW5wdXQubGVuZ3RoKSB0aGlzLnJhaXNlKHRoaXMuc3RhcnQsIFwiVW50ZXJtaW5hdGVkIHRlbXBsYXRlXCIpO1xuICAgIHZhciBjaCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7XG4gICAgaWYgKGNoID09PSA5NiB8fCBjaCA9PT0gMzYgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSkgPT09IDEyMykge1xuICAgICAgLy8gJ2AnLCAnJHsnXG4gICAgICBpZiAodGhpcy5wb3MgPT09IHRoaXMuc3RhcnQgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnRlbXBsYXRlKSB7XG4gICAgICAgIGlmIChjaCA9PT0gMzYpIHtcbiAgICAgICAgICB0aGlzLnBvcyArPSAyO1xuICAgICAgICAgIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuZG9sbGFyQnJhY2VMKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICArK3RoaXMucG9zO1xuICAgICAgICAgIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgb3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCwgdGhpcy5wb3MpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy50ZW1wbGF0ZSwgb3V0KTtcbiAgICB9XG4gICAgaWYgKGNoID09PSA5Mikge1xuICAgICAgLy8gJ1xcJ1xuICAgICAgb3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCwgdGhpcy5wb3MpO1xuICAgICAgb3V0ICs9IHRoaXMucmVhZEVzY2FwZWRDaGFyKHRydWUpO1xuICAgICAgY2h1bmtTdGFydCA9IHRoaXMucG9zO1xuICAgIH0gZWxzZSBpZiAoX3doaXRlc3BhY2UuaXNOZXdMaW5lKGNoKSkge1xuICAgICAgb3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCwgdGhpcy5wb3MpO1xuICAgICAgKyt0aGlzLnBvcztcbiAgICAgIHN3aXRjaCAoY2gpIHtcbiAgICAgICAgY2FzZSAxMzpcbiAgICAgICAgICBpZiAodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSA9PT0gMTApICsrdGhpcy5wb3M7XG4gICAgICAgIGNhc2UgMTA6XG4gICAgICAgICAgb3V0ICs9IFwiXFxuXCI7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgb3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoY2gpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHtcbiAgICAgICAgKyt0aGlzLmN1ckxpbmU7XG4gICAgICAgIHRoaXMubGluZVN0YXJ0ID0gdGhpcy5wb3M7XG4gICAgICB9XG4gICAgICBjaHVua1N0YXJ0ID0gdGhpcy5wb3M7XG4gICAgfSBlbHNlIHtcbiAgICAgICsrdGhpcy5wb3M7XG4gICAgfVxuICB9XG59O1xuXG4vLyBVc2VkIHRvIHJlYWQgZXNjYXBlZCBjaGFyYWN0ZXJzXG5cbnBwLnJlYWRFc2NhcGVkQ2hhciA9IGZ1bmN0aW9uIChpblRlbXBsYXRlKSB7XG4gIHZhciBjaCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCgrK3RoaXMucG9zKTtcbiAgKyt0aGlzLnBvcztcbiAgc3dpdGNoIChjaCkge1xuICAgIGNhc2UgMTEwOlxuICAgICAgcmV0dXJuIFwiXFxuXCI7IC8vICduJyAtPiAnXFxuJ1xuICAgIGNhc2UgMTE0OlxuICAgICAgcmV0dXJuIFwiXFxyXCI7IC8vICdyJyAtPiAnXFxyJ1xuICAgIGNhc2UgMTIwOlxuICAgICAgcmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUodGhpcy5yZWFkSGV4Q2hhcigyKSk7IC8vICd4J1xuICAgIGNhc2UgMTE3OlxuICAgICAgcmV0dXJuIGNvZGVQb2ludFRvU3RyaW5nKHRoaXMucmVhZENvZGVQb2ludCgpKTsgLy8gJ3UnXG4gICAgY2FzZSAxMTY6XG4gICAgICByZXR1cm4gXCJcXHRcIjsgLy8gJ3QnIC0+ICdcXHQnXG4gICAgY2FzZSA5ODpcbiAgICAgIHJldHVybiBcIlxcYlwiOyAvLyAnYicgLT4gJ1xcYidcbiAgICBjYXNlIDExODpcbiAgICAgIHJldHVybiBcIlxcdTAwMGJcIjsgLy8gJ3YnIC0+ICdcXHUwMDBiJ1xuICAgIGNhc2UgMTAyOlxuICAgICAgcmV0dXJuIFwiXFxmXCI7IC8vICdmJyAtPiAnXFxmJ1xuICAgIGNhc2UgMTM6XG4gICAgICBpZiAodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSA9PT0gMTApICsrdGhpcy5wb3M7IC8vICdcXHJcXG4nXG4gICAgY2FzZSAxMDpcbiAgICAgIC8vICcgXFxuJ1xuICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHtcbiAgICAgICAgdGhpcy5saW5lU3RhcnQgPSB0aGlzLnBvczsrK3RoaXMuY3VyTGluZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBcIlwiO1xuICAgIGRlZmF1bHQ6XG4gICAgICBpZiAoY2ggPj0gNDggJiYgY2ggPD0gNTUpIHtcbiAgICAgICAgdmFyIG9jdGFsU3RyID0gdGhpcy5pbnB1dC5zdWJzdHIodGhpcy5wb3MgLSAxLCAzKS5tYXRjaCgvXlswLTddKy8pWzBdO1xuICAgICAgICB2YXIgb2N0YWwgPSBwYXJzZUludChvY3RhbFN0ciwgOCk7XG4gICAgICAgIGlmIChvY3RhbCA+IDI1NSkge1xuICAgICAgICAgIG9jdGFsU3RyID0gb2N0YWxTdHIuc2xpY2UoMCwgLTEpO1xuICAgICAgICAgIG9jdGFsID0gcGFyc2VJbnQob2N0YWxTdHIsIDgpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChvY3RhbCA+IDAgJiYgKHRoaXMuc3RyaWN0IHx8IGluVGVtcGxhdGUpKSB7XG4gICAgICAgICAgdGhpcy5yYWlzZSh0aGlzLnBvcyAtIDIsIFwiT2N0YWwgbGl0ZXJhbCBpbiBzdHJpY3QgbW9kZVwiKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnBvcyArPSBvY3RhbFN0ci5sZW5ndGggLSAxO1xuICAgICAgICByZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZShvY3RhbCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZShjaCk7XG4gIH1cbn07XG5cbi8vIFVzZWQgdG8gcmVhZCBjaGFyYWN0ZXIgZXNjYXBlIHNlcXVlbmNlcyAoJ1xceCcsICdcXHUnLCAnXFxVJykuXG5cbnBwLnJlYWRIZXhDaGFyID0gZnVuY3Rpb24gKGxlbikge1xuICB2YXIgY29kZVBvcyA9IHRoaXMucG9zO1xuICB2YXIgbiA9IHRoaXMucmVhZEludCgxNiwgbGVuKTtcbiAgaWYgKG4gPT09IG51bGwpIHRoaXMucmFpc2UoY29kZVBvcywgXCJCYWQgY2hhcmFjdGVyIGVzY2FwZSBzZXF1ZW5jZVwiKTtcbiAgcmV0dXJuIG47XG59O1xuXG4vLyBSZWFkIGFuIGlkZW50aWZpZXIsIGFuZCByZXR1cm4gaXQgYXMgYSBzdHJpbmcuIFNldHMgYHRoaXMuY29udGFpbnNFc2NgXG4vLyB0byB3aGV0aGVyIHRoZSB3b3JkIGNvbnRhaW5lZCBhICdcXHUnIGVzY2FwZS5cbi8vXG4vLyBJbmNyZW1lbnRhbGx5IGFkZHMgb25seSBlc2NhcGVkIGNoYXJzLCBhZGRpbmcgb3RoZXIgY2h1bmtzIGFzLWlzXG4vLyBhcyBhIG1pY3JvLW9wdGltaXphdGlvbi5cblxucHAucmVhZFdvcmQxID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLmNvbnRhaW5zRXNjID0gZmFsc2U7XG4gIHZhciB3b3JkID0gXCJcIixcbiAgICAgIGZpcnN0ID0gdHJ1ZSxcbiAgICAgIGNodW5rU3RhcnQgPSB0aGlzLnBvcztcbiAgdmFyIGFzdHJhbCA9IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2O1xuICB3aGlsZSAodGhpcy5wb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCkge1xuICAgIHZhciBjaCA9IHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKTtcbiAgICBpZiAoX2lkZW50aWZpZXIuaXNJZGVudGlmaWVyQ2hhcihjaCwgYXN0cmFsKSkge1xuICAgICAgdGhpcy5wb3MgKz0gY2ggPD0gMHhmZmZmID8gMSA6IDI7XG4gICAgfSBlbHNlIGlmIChjaCA9PT0gOTIpIHtcbiAgICAgIC8vIFwiXFxcIlxuICAgICAgdGhpcy5jb250YWluc0VzYyA9IHRydWU7XG4gICAgICB3b3JkICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCwgdGhpcy5wb3MpO1xuICAgICAgdmFyIGVzY1N0YXJ0ID0gdGhpcy5wb3M7XG4gICAgICBpZiAodGhpcy5pbnB1dC5jaGFyQ29kZUF0KCsrdGhpcy5wb3MpICE9IDExNykgLy8gXCJ1XCJcbiAgICAgICAgdGhpcy5yYWlzZSh0aGlzLnBvcywgXCJFeHBlY3RpbmcgVW5pY29kZSBlc2NhcGUgc2VxdWVuY2UgXFxcXHVYWFhYXCIpO1xuICAgICAgKyt0aGlzLnBvcztcbiAgICAgIHZhciBlc2MgPSB0aGlzLnJlYWRDb2RlUG9pbnQoKTtcbiAgICAgIGlmICghKGZpcnN0ID8gX2lkZW50aWZpZXIuaXNJZGVudGlmaWVyU3RhcnQgOiBfaWRlbnRpZmllci5pc0lkZW50aWZpZXJDaGFyKShlc2MsIGFzdHJhbCkpIHRoaXMucmFpc2UoZXNjU3RhcnQsIFwiSW52YWxpZCBVbmljb2RlIGVzY2FwZVwiKTtcbiAgICAgIHdvcmQgKz0gY29kZVBvaW50VG9TdHJpbmcoZXNjKTtcbiAgICAgIGNodW5rU3RhcnQgPSB0aGlzLnBvcztcbiAgICB9IGVsc2Uge1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGZpcnN0ID0gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHdvcmQgKyB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsIHRoaXMucG9zKTtcbn07XG5cbi8vIFJlYWQgYW4gaWRlbnRpZmllciBvciBrZXl3b3JkIHRva2VuLiBXaWxsIGNoZWNrIGZvciByZXNlcnZlZFxuLy8gd29yZHMgd2hlbiBuZWNlc3NhcnkuXG5cbnBwLnJlYWRXb3JkID0gZnVuY3Rpb24gKCkge1xuICB2YXIgd29yZCA9IHRoaXMucmVhZFdvcmQxKCk7XG4gIHZhciB0eXBlID0gX3Rva2VudHlwZS50eXBlcy5uYW1lO1xuICBpZiAoKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2IHx8ICF0aGlzLmNvbnRhaW5zRXNjKSAmJiB0aGlzLmlzS2V5d29yZCh3b3JkKSkgdHlwZSA9IF90b2tlbnR5cGUua2V5d29yZHNbd29yZF07XG4gIHJldHVybiB0aGlzLmZpbmlzaFRva2VuKHR5cGUsIHdvcmQpO1xufTtcblxufSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9sb2N1dGlsXCI6NSxcIi4vc3RhdGVcIjoxMCxcIi4vdG9rZW50eXBlXCI6MTQsXCIuL3doaXRlc3BhY2VcIjoxNn1dLDE0OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcbi8vICMjIFRva2VuIHR5cGVzXG5cbi8vIFRoZSBhc3NpZ25tZW50IG9mIGZpbmUtZ3JhaW5lZCwgaW5mb3JtYXRpb24tY2FycnlpbmcgdHlwZSBvYmplY3RzXG4vLyBhbGxvd3MgdGhlIHRva2VuaXplciB0byBzdG9yZSB0aGUgaW5mb3JtYXRpb24gaXQgaGFzIGFib3V0IGFcbi8vIHRva2VuIGluIGEgd2F5IHRoYXQgaXMgdmVyeSBjaGVhcCBmb3IgdGhlIHBhcnNlciB0byBsb29rIHVwLlxuXG4vLyBBbGwgdG9rZW4gdHlwZSB2YXJpYWJsZXMgc3RhcnQgd2l0aCBhbiB1bmRlcnNjb3JlLCB0byBtYWtlIHRoZW1cbi8vIGVhc3kgdG8gcmVjb2duaXplLlxuXG4vLyBUaGUgYGJlZm9yZUV4cHJgIHByb3BlcnR5IGlzIHVzZWQgdG8gZGlzYW1iaWd1YXRlIGJldHdlZW4gcmVndWxhclxuLy8gZXhwcmVzc2lvbnMgYW5kIGRpdmlzaW9ucy4gSXQgaXMgc2V0IG9uIGFsbCB0b2tlbiB0eXBlcyB0aGF0IGNhblxuLy8gYmUgZm9sbG93ZWQgYnkgYW4gZXhwcmVzc2lvbiAodGh1cywgYSBzbGFzaCBhZnRlciB0aGVtIHdvdWxkIGJlIGFcbi8vIHJlZ3VsYXIgZXhwcmVzc2lvbikuXG4vL1xuLy8gYGlzTG9vcGAgbWFya3MgYSBrZXl3b3JkIGFzIHN0YXJ0aW5nIGEgbG9vcCwgd2hpY2ggaXMgaW1wb3J0YW50XG4vLyB0byBrbm93IHdoZW4gcGFyc2luZyBhIGxhYmVsLCBpbiBvcmRlciB0byBhbGxvdyBvciBkaXNhbGxvd1xuLy8gY29udGludWUganVtcHMgdG8gdGhhdCBsYWJlbC5cblxuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbnZhciBUb2tlblR5cGUgPSBmdW5jdGlvbiBUb2tlblR5cGUobGFiZWwpIHtcbiAgdmFyIGNvbmYgPSBhcmd1bWVudHMubGVuZ3RoIDw9IDEgfHwgYXJndW1lbnRzWzFdID09PSB1bmRlZmluZWQgPyB7fSA6IGFyZ3VtZW50c1sxXTtcblxuICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgVG9rZW5UeXBlKTtcblxuICB0aGlzLmxhYmVsID0gbGFiZWw7XG4gIHRoaXMua2V5d29yZCA9IGNvbmYua2V5d29yZDtcbiAgdGhpcy5iZWZvcmVFeHByID0gISFjb25mLmJlZm9yZUV4cHI7XG4gIHRoaXMuc3RhcnRzRXhwciA9ICEhY29uZi5zdGFydHNFeHByO1xuICB0aGlzLmlzTG9vcCA9ICEhY29uZi5pc0xvb3A7XG4gIHRoaXMuaXNBc3NpZ24gPSAhIWNvbmYuaXNBc3NpZ247XG4gIHRoaXMucHJlZml4ID0gISFjb25mLnByZWZpeDtcbiAgdGhpcy5wb3N0Zml4ID0gISFjb25mLnBvc3RmaXg7XG4gIHRoaXMuYmlub3AgPSBjb25mLmJpbm9wIHx8IG51bGw7XG4gIHRoaXMudXBkYXRlQ29udGV4dCA9IG51bGw7XG59O1xuXG5leHBvcnRzLlRva2VuVHlwZSA9IFRva2VuVHlwZTtcblxuZnVuY3Rpb24gYmlub3AobmFtZSwgcHJlYykge1xuICByZXR1cm4gbmV3IFRva2VuVHlwZShuYW1lLCB7IGJlZm9yZUV4cHI6IHRydWUsIGJpbm9wOiBwcmVjIH0pO1xufVxudmFyIGJlZm9yZUV4cHIgPSB7IGJlZm9yZUV4cHI6IHRydWUgfSxcbiAgICBzdGFydHNFeHByID0geyBzdGFydHNFeHByOiB0cnVlIH07XG5cbnZhciB0eXBlcyA9IHtcbiAgbnVtOiBuZXcgVG9rZW5UeXBlKFwibnVtXCIsIHN0YXJ0c0V4cHIpLFxuICByZWdleHA6IG5ldyBUb2tlblR5cGUoXCJyZWdleHBcIiwgc3RhcnRzRXhwciksXG4gIHN0cmluZzogbmV3IFRva2VuVHlwZShcInN0cmluZ1wiLCBzdGFydHNFeHByKSxcbiAgbmFtZTogbmV3IFRva2VuVHlwZShcIm5hbWVcIiwgc3RhcnRzRXhwciksXG4gIGVvZjogbmV3IFRva2VuVHlwZShcImVvZlwiKSxcblxuICAvLyBQdW5jdHVhdGlvbiB0b2tlbiB0eXBlcy5cbiAgYnJhY2tldEw6IG5ldyBUb2tlblR5cGUoXCJbXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KSxcbiAgYnJhY2tldFI6IG5ldyBUb2tlblR5cGUoXCJdXCIpLFxuICBicmFjZUw6IG5ldyBUb2tlblR5cGUoXCJ7XCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KSxcbiAgYnJhY2VSOiBuZXcgVG9rZW5UeXBlKFwifVwiKSxcbiAgcGFyZW5MOiBuZXcgVG9rZW5UeXBlKFwiKFwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSksXG4gIHBhcmVuUjogbmV3IFRva2VuVHlwZShcIilcIiksXG4gIGNvbW1hOiBuZXcgVG9rZW5UeXBlKFwiLFwiLCBiZWZvcmVFeHByKSxcbiAgc2VtaTogbmV3IFRva2VuVHlwZShcIjtcIiwgYmVmb3JlRXhwciksXG4gIGNvbG9uOiBuZXcgVG9rZW5UeXBlKFwiOlwiLCBiZWZvcmVFeHByKSxcbiAgZG90OiBuZXcgVG9rZW5UeXBlKFwiLlwiKSxcbiAgcXVlc3Rpb246IG5ldyBUb2tlblR5cGUoXCI/XCIsIGJlZm9yZUV4cHIpLFxuICBhcnJvdzogbmV3IFRva2VuVHlwZShcIj0+XCIsIGJlZm9yZUV4cHIpLFxuICB0ZW1wbGF0ZTogbmV3IFRva2VuVHlwZShcInRlbXBsYXRlXCIpLFxuICBlbGxpcHNpczogbmV3IFRva2VuVHlwZShcIi4uLlwiLCBiZWZvcmVFeHByKSxcbiAgYmFja1F1b3RlOiBuZXcgVG9rZW5UeXBlKFwiYFwiLCBzdGFydHNFeHByKSxcbiAgZG9sbGFyQnJhY2VMOiBuZXcgVG9rZW5UeXBlKFwiJHtcIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pLFxuXG4gIC8vIE9wZXJhdG9ycy4gVGhlc2UgY2Fycnkgc2V2ZXJhbCBraW5kcyBvZiBwcm9wZXJ0aWVzIHRvIGhlbHAgdGhlXG4gIC8vIHBhcnNlciB1c2UgdGhlbSBwcm9wZXJseSAodGhlIHByZXNlbmNlIG9mIHRoZXNlIHByb3BlcnRpZXMgaXNcbiAgLy8gd2hhdCBjYXRlZ29yaXplcyB0aGVtIGFzIG9wZXJhdG9ycykuXG4gIC8vXG4gIC8vIGBiaW5vcGAsIHdoZW4gcHJlc2VudCwgc3BlY2lmaWVzIHRoYXQgdGhpcyBvcGVyYXRvciBpcyBhIGJpbmFyeVxuICAvLyBvcGVyYXRvciwgYW5kIHdpbGwgcmVmZXIgdG8gaXRzIHByZWNlZGVuY2UuXG4gIC8vXG4gIC8vIGBwcmVmaXhgIGFuZCBgcG9zdGZpeGAgbWFyayB0aGUgb3BlcmF0b3IgYXMgYSBwcmVmaXggb3IgcG9zdGZpeFxuICAvLyB1bmFyeSBvcGVyYXRvci5cbiAgLy9cbiAgLy8gYGlzQXNzaWduYCBtYXJrcyBhbGwgb2YgYD1gLCBgKz1gLCBgLT1gIGV0Y2V0ZXJhLCB3aGljaCBhY3QgYXNcbiAgLy8gYmluYXJ5IG9wZXJhdG9ycyB3aXRoIGEgdmVyeSBsb3cgcHJlY2VkZW5jZSwgdGhhdCBzaG91bGQgcmVzdWx0XG4gIC8vIGluIEFzc2lnbm1lbnRFeHByZXNzaW9uIG5vZGVzLlxuXG4gIGVxOiBuZXcgVG9rZW5UeXBlKFwiPVwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIGlzQXNzaWduOiB0cnVlIH0pLFxuICBhc3NpZ246IG5ldyBUb2tlblR5cGUoXCJfPVwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIGlzQXNzaWduOiB0cnVlIH0pLFxuICBpbmNEZWM6IG5ldyBUb2tlblR5cGUoXCIrKy8tLVwiLCB7IHByZWZpeDogdHJ1ZSwgcG9zdGZpeDogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KSxcbiAgcHJlZml4OiBuZXcgVG9rZW5UeXBlKFwicHJlZml4XCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgcHJlZml4OiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pLFxuICBsb2dpY2FsT1I6IGJpbm9wKFwifHxcIiwgMSksXG4gIGxvZ2ljYWxBTkQ6IGJpbm9wKFwiJiZcIiwgMiksXG4gIGJpdHdpc2VPUjogYmlub3AoXCJ8XCIsIDMpLFxuICBiaXR3aXNlWE9SOiBiaW5vcChcIl5cIiwgNCksXG4gIGJpdHdpc2VBTkQ6IGJpbm9wKFwiJlwiLCA1KSxcbiAgZXF1YWxpdHk6IGJpbm9wKFwiPT0vIT1cIiwgNiksXG4gIHJlbGF0aW9uYWw6IGJpbm9wKFwiPC8+XCIsIDcpLFxuICBiaXRTaGlmdDogYmlub3AoXCI8PC8+PlwiLCA4KSxcbiAgcGx1c01pbjogbmV3IFRva2VuVHlwZShcIisvLVwiLCB7IGJlZm9yZUV4cHI6IHRydWUsIGJpbm9wOiA5LCBwcmVmaXg6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSksXG4gIG1vZHVsbzogYmlub3AoXCIlXCIsIDEwKSxcbiAgc3RhcjogYmlub3AoXCIqXCIsIDEwKSxcbiAgc2xhc2g6IGJpbm9wKFwiL1wiLCAxMClcbn07XG5cbmV4cG9ydHMudHlwZXMgPSB0eXBlcztcbi8vIE1hcCBrZXl3b3JkIG5hbWVzIHRvIHRva2VuIHR5cGVzLlxuXG52YXIga2V5d29yZHMgPSB7fTtcblxuZXhwb3J0cy5rZXl3b3JkcyA9IGtleXdvcmRzO1xuLy8gU3VjY2luY3QgZGVmaW5pdGlvbnMgb2Yga2V5d29yZCB0b2tlbiB0eXBlc1xuZnVuY3Rpb24ga3cobmFtZSkge1xuICB2YXIgb3B0aW9ucyA9IGFyZ3VtZW50cy5sZW5ndGggPD0gMSB8fCBhcmd1bWVudHNbMV0gPT09IHVuZGVmaW5lZCA/IHt9IDogYXJndW1lbnRzWzFdO1xuXG4gIG9wdGlvbnMua2V5d29yZCA9IG5hbWU7XG4gIGtleXdvcmRzW25hbWVdID0gdHlwZXNbXCJfXCIgKyBuYW1lXSA9IG5ldyBUb2tlblR5cGUobmFtZSwgb3B0aW9ucyk7XG59XG5cbmt3KFwiYnJlYWtcIik7XG5rdyhcImNhc2VcIiwgYmVmb3JlRXhwcik7XG5rdyhcImNhdGNoXCIpO1xua3coXCJjb250aW51ZVwiKTtcbmt3KFwiZGVidWdnZXJcIik7XG5rdyhcImRlZmF1bHRcIiwgYmVmb3JlRXhwcik7XG5rdyhcImRvXCIsIHsgaXNMb29wOiB0cnVlIH0pO1xua3coXCJlbHNlXCIsIGJlZm9yZUV4cHIpO1xua3coXCJmaW5hbGx5XCIpO1xua3coXCJmb3JcIiwgeyBpc0xvb3A6IHRydWUgfSk7XG5rdyhcImZ1bmN0aW9uXCIsIHN0YXJ0c0V4cHIpO1xua3coXCJpZlwiKTtcbmt3KFwicmV0dXJuXCIsIGJlZm9yZUV4cHIpO1xua3coXCJzd2l0Y2hcIik7XG5rdyhcInRocm93XCIsIGJlZm9yZUV4cHIpO1xua3coXCJ0cnlcIik7XG5rdyhcInZhclwiKTtcbmt3KFwibGV0XCIpO1xua3coXCJjb25zdFwiKTtcbmt3KFwid2hpbGVcIiwgeyBpc0xvb3A6IHRydWUgfSk7XG5rdyhcIndpdGhcIik7XG5rdyhcIm5ld1wiLCB7IGJlZm9yZUV4cHI6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSk7XG5rdyhcInRoaXNcIiwgc3RhcnRzRXhwcik7XG5rdyhcInN1cGVyXCIsIHN0YXJ0c0V4cHIpO1xua3coXCJjbGFzc1wiKTtcbmt3KFwiZXh0ZW5kc1wiLCBiZWZvcmVFeHByKTtcbmt3KFwiZXhwb3J0XCIpO1xua3coXCJpbXBvcnRcIik7XG5rdyhcInlpZWxkXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgc3RhcnRzRXhwcjogdHJ1ZSB9KTtcbmt3KFwibnVsbFwiLCBzdGFydHNFeHByKTtcbmt3KFwidHJ1ZVwiLCBzdGFydHNFeHByKTtcbmt3KFwiZmFsc2VcIiwgc3RhcnRzRXhwcik7XG5rdyhcImluXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgYmlub3A6IDcgfSk7XG5rdyhcImluc3RhbmNlb2ZcIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBiaW5vcDogNyB9KTtcbmt3KFwidHlwZW9mXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgcHJlZml4OiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pO1xua3coXCJ2b2lkXCIsIHsgYmVmb3JlRXhwcjogdHJ1ZSwgcHJlZml4OiB0cnVlLCBzdGFydHNFeHByOiB0cnVlIH0pO1xua3coXCJkZWxldGVcIiwgeyBiZWZvcmVFeHByOiB0cnVlLCBwcmVmaXg6IHRydWUsIHN0YXJ0c0V4cHI6IHRydWUgfSk7XG5cbn0se31dLDE1OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5pc0FycmF5ID0gaXNBcnJheTtcbmV4cG9ydHMuaGFzID0gaGFzO1xuXG5mdW5jdGlvbiBpc0FycmF5KG9iaikge1xuICByZXR1cm4gT2JqZWN0LnByb3RvdHlwZS50b1N0cmluZy5jYWxsKG9iaikgPT09IFwiW29iamVjdCBBcnJheV1cIjtcbn1cblxuLy8gQ2hlY2tzIGlmIGFuIG9iamVjdCBoYXMgYSBwcm9wZXJ0eS5cblxuZnVuY3Rpb24gaGFzKG9iaiwgcHJvcE5hbWUpIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3BOYW1lKTtcbn1cblxufSx7fV0sMTY6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuLy8gTWF0Y2hlcyBhIHdob2xlIGxpbmUgYnJlYWsgKHdoZXJlIENSTEYgaXMgY29uc2lkZXJlZCBhIHNpbmdsZVxuLy8gbGluZSBicmVhaykuIFVzZWQgdG8gY291bnQgbGluZXMuXG5cblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuZXhwb3J0cy5pc05ld0xpbmUgPSBpc05ld0xpbmU7XG52YXIgbGluZUJyZWFrID0gL1xcclxcbj98XFxufFxcdTIwMjh8XFx1MjAyOS87XG5leHBvcnRzLmxpbmVCcmVhayA9IGxpbmVCcmVhaztcbnZhciBsaW5lQnJlYWtHID0gbmV3IFJlZ0V4cChsaW5lQnJlYWsuc291cmNlLCBcImdcIik7XG5cbmV4cG9ydHMubGluZUJyZWFrRyA9IGxpbmVCcmVha0c7XG5cbmZ1bmN0aW9uIGlzTmV3TGluZShjb2RlKSB7XG4gIHJldHVybiBjb2RlID09PSAxMCB8fCBjb2RlID09PSAxMyB8fCBjb2RlID09PSAweDIwMjggfHwgY29kZSA9PSAweDIwMjk7XG59XG5cbnZhciBub25BU0NJSXdoaXRlc3BhY2UgPSAvW1xcdTE2ODBcXHUxODBlXFx1MjAwMC1cXHUyMDBhXFx1MjAyZlxcdTIwNWZcXHUzMDAwXFx1ZmVmZl0vO1xuZXhwb3J0cy5ub25BU0NJSXdoaXRlc3BhY2UgPSBub25BU0NJSXdoaXRlc3BhY2U7XG5cbn0se31dfSx7fSxbM10pKDMpXG59KTsiLCIoZnVuY3Rpb24oZil7aWYodHlwZW9mIGV4cG9ydHM9PT1cIm9iamVjdFwiJiZ0eXBlb2YgbW9kdWxlIT09XCJ1bmRlZmluZWRcIil7bW9kdWxlLmV4cG9ydHM9ZigpfWVsc2UgaWYodHlwZW9mIGRlZmluZT09PVwiZnVuY3Rpb25cIiYmZGVmaW5lLmFtZCl7ZGVmaW5lKFtdLGYpfWVsc2V7dmFyIGc7aWYodHlwZW9mIHdpbmRvdyE9PVwidW5kZWZpbmVkXCIpe2c9d2luZG93fWVsc2UgaWYodHlwZW9mIGdsb2JhbCE9PVwidW5kZWZpbmVkXCIpe2c9Z2xvYmFsfWVsc2UgaWYodHlwZW9mIHNlbGYhPT1cInVuZGVmaW5lZFwiKXtnPXNlbGZ9ZWxzZXtnPXRoaXN9KGcuYWNvcm4gfHwgKGcuYWNvcm4gPSB7fSkpLmxvb3NlID0gZigpfX0pKGZ1bmN0aW9uKCl7dmFyIGRlZmluZSxtb2R1bGUsZXhwb3J0cztyZXR1cm4gKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkoezE6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuKGZ1bmN0aW9uIChnbG9iYWwpe1xuXCJ1c2Ugc3RyaWN0XCI7KGZ1bmN0aW9uKGYpe2lmKHR5cGVvZiBleHBvcnRzID09PSBcIm9iamVjdFwiICYmIHR5cGVvZiBtb2R1bGUgIT09IFwidW5kZWZpbmVkXCIpe21vZHVsZS5leHBvcnRzID0gZigpO31lbHNlIGlmKHR5cGVvZiBkZWZpbmUgPT09IFwiZnVuY3Rpb25cIiAmJiBkZWZpbmUuYW1kKXtkZWZpbmUoW10sZik7fWVsc2Uge3ZhciBnO2lmKHR5cGVvZiB3aW5kb3cgIT09IFwidW5kZWZpbmVkXCIpe2cgPSB3aW5kb3c7fWVsc2UgaWYodHlwZW9mIGdsb2JhbCAhPT0gXCJ1bmRlZmluZWRcIil7ZyA9IGdsb2JhbDt9ZWxzZSBpZih0eXBlb2Ygc2VsZiAhPT0gXCJ1bmRlZmluZWRcIil7ZyA9IHNlbGY7fWVsc2Uge2cgPSB0aGlzO31nLmFjb3JuID0gZigpO319KShmdW5jdGlvbigpe3ZhciBkZWZpbmUsbW9kdWxlLGV4cG9ydHM7cmV0dXJuIChmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgX2RlcmVxXyA9PSBcImZ1bmN0aW9uXCIgJiYgX2RlcmVxXztpZighdSAmJiBhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIiArIG8gKyBcIidcIik7dGhyb3cgKGYuY29kZSA9IFwiTU9EVUxFX05PVF9GT1VORFwiLGYpO312YXIgbD1uW29dID0ge2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSk7fSxsLGwuZXhwb3J0cyxlLHQsbixyKTt9cmV0dXJuIG5bb10uZXhwb3J0czt9dmFyIGk9dHlwZW9mIF9kZXJlcV8gPT0gXCJmdW5jdGlvblwiICYmIF9kZXJlcV87Zm9yKHZhciBvPTA7byA8IHIubGVuZ3RoO28rKykgcyhyW29dKTtyZXR1cm4gczt9KSh7MTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7IC8vIEEgcmVjdXJzaXZlIGRlc2NlbnQgcGFyc2VyIG9wZXJhdGVzIGJ5IGRlZmluaW5nIGZ1bmN0aW9ucyBmb3IgYWxsXG4vLyBzeW50YWN0aWMgZWxlbWVudHMsIGFuZCByZWN1cnNpdmVseSBjYWxsaW5nIHRob3NlLCBlYWNoIGZ1bmN0aW9uXG4vLyBhZHZhbmNpbmcgdGhlIGlucHV0IHN0cmVhbSBhbmQgcmV0dXJuaW5nIGFuIEFTVCBub2RlLiBQcmVjZWRlbmNlXG4vLyBvZiBjb25zdHJ1Y3RzIChmb3IgZXhhbXBsZSwgdGhlIGZhY3QgdGhhdCBgIXhbMV1gIG1lYW5zIGAhKHhbMV0pYFxuLy8gaW5zdGVhZCBvZiBgKCF4KVsxXWAgaXMgaGFuZGxlZCBieSB0aGUgZmFjdCB0aGF0IHRoZSBwYXJzZXJcbi8vIGZ1bmN0aW9uIHRoYXQgcGFyc2VzIHVuYXJ5IHByZWZpeCBvcGVyYXRvcnMgaXMgY2FsbGVkIGZpcnN0LCBhbmRcbi8vIGluIHR1cm4gY2FsbHMgdGhlIGZ1bmN0aW9uIHRoYXQgcGFyc2VzIGBbXWAgc3Vic2NyaXB0cyDigJQgdGhhdFxuLy8gd2F5LCBpdCdsbCByZWNlaXZlIHRoZSBub2RlIGZvciBgeFsxXWAgYWxyZWFkeSBwYXJzZWQsIGFuZCB3cmFwc1xuLy8gKnRoYXQqIGluIHRoZSB1bmFyeSBvcGVyYXRvciBub2RlLlxuLy9cbi8vIEFjb3JuIHVzZXMgYW4gW29wZXJhdG9yIHByZWNlZGVuY2UgcGFyc2VyXVtvcHBdIHRvIGhhbmRsZSBiaW5hcnlcbi8vIG9wZXJhdG9yIHByZWNlZGVuY2UsIGJlY2F1c2UgaXQgaXMgbXVjaCBtb3JlIGNvbXBhY3QgdGhhbiB1c2luZ1xuLy8gdGhlIHRlY2huaXF1ZSBvdXRsaW5lZCBhYm92ZSwgd2hpY2ggdXNlcyBkaWZmZXJlbnQsIG5lc3Rpbmdcbi8vIGZ1bmN0aW9ucyB0byBzcGVjaWZ5IHByZWNlZGVuY2UsIGZvciBhbGwgb2YgdGhlIHRlbiBiaW5hcnlcbi8vIHByZWNlZGVuY2UgbGV2ZWxzIHRoYXQgSmF2YVNjcmlwdCBkZWZpbmVzLlxuLy9cbi8vIFtvcHBdOiBodHRwOi8vZW4ud2lraXBlZGlhLm9yZy93aWtpL09wZXJhdG9yLXByZWNlZGVuY2VfcGFyc2VyXG5cInVzZSBzdHJpY3RcIjt2YXIgX3Rva2VudHlwZT1fZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX2lkZW50aWZpZXI9X2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTt2YXIgX3V0aWw9X2RlcmVxXyhcIi4vdXRpbFwiKTt2YXIgcHA9X3N0YXRlLlBhcnNlci5wcm90b3R5cGU7IC8vIENoZWNrIGlmIHByb3BlcnR5IG5hbWUgY2xhc2hlcyB3aXRoIGFscmVhZHkgYWRkZWQuXG4vLyBPYmplY3QvY2xhc3MgZ2V0dGVycyBhbmQgc2V0dGVycyBhcmUgbm90IGFsbG93ZWQgdG8gY2xhc2gg4oCUXG4vLyBlaXRoZXIgd2l0aCBlYWNoIG90aGVyIG9yIHdpdGggYW4gaW5pdCBwcm9wZXJ0eSDigJQgYW5kIGluXG4vLyBzdHJpY3QgbW9kZSwgaW5pdCBwcm9wZXJ0aWVzIGFyZSBhbHNvIG5vdCBhbGxvd2VkIHRvIGJlIHJlcGVhdGVkLlxucHAuY2hlY2tQcm9wQ2xhc2ggPSBmdW5jdGlvbihwcm9wLHByb3BIYXNoKXtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiAocHJvcC5jb21wdXRlZCB8fCBwcm9wLm1ldGhvZCB8fCBwcm9wLnNob3J0aGFuZCkpcmV0dXJuO3ZhciBrZXk9cHJvcC5rZXksbmFtZT11bmRlZmluZWQ7c3dpdGNoKGtleS50eXBlKXtjYXNlIFwiSWRlbnRpZmllclwiOm5hbWUgPSBrZXkubmFtZTticmVhaztjYXNlIFwiTGl0ZXJhbFwiOm5hbWUgPSBTdHJpbmcoa2V5LnZhbHVlKTticmVhaztkZWZhdWx0OnJldHVybjt9dmFyIGtpbmQ9cHJvcC5raW5kO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXtpZihuYW1lID09PSBcIl9fcHJvdG9fX1wiICYmIGtpbmQgPT09IFwiaW5pdFwiKXtpZihwcm9wSGFzaC5wcm90byl0aGlzLnJhaXNlKGtleS5zdGFydCxcIlJlZGVmaW5pdGlvbiBvZiBfX3Byb3RvX18gcHJvcGVydHlcIik7cHJvcEhhc2gucHJvdG8gPSB0cnVlO31yZXR1cm47fXZhciBvdGhlcj11bmRlZmluZWQ7aWYoX3V0aWwuaGFzKHByb3BIYXNoLG5hbWUpKXtvdGhlciA9IHByb3BIYXNoW25hbWVdO3ZhciBpc0dldFNldD1raW5kICE9PSBcImluaXRcIjtpZigodGhpcy5zdHJpY3QgfHwgaXNHZXRTZXQpICYmIG90aGVyW2tpbmRdIHx8ICEoaXNHZXRTZXQgXiBvdGhlci5pbml0KSl0aGlzLnJhaXNlKGtleS5zdGFydCxcIlJlZGVmaW5pdGlvbiBvZiBwcm9wZXJ0eVwiKTt9ZWxzZSB7b3RoZXIgPSBwcm9wSGFzaFtuYW1lXSA9IHtpbml0OmZhbHNlLGdldDpmYWxzZSxzZXQ6ZmFsc2V9O31vdGhlcltraW5kXSA9IHRydWU7fTsgLy8gIyMjIEV4cHJlc3Npb24gcGFyc2luZ1xuLy8gVGhlc2UgbmVzdCwgZnJvbSB0aGUgbW9zdCBnZW5lcmFsIGV4cHJlc3Npb24gdHlwZSBhdCB0aGUgdG9wIHRvXG4vLyAnYXRvbWljJywgbm9uZGl2aXNpYmxlIGV4cHJlc3Npb24gdHlwZXMgYXQgdGhlIGJvdHRvbS4gTW9zdCBvZlxuLy8gdGhlIGZ1bmN0aW9ucyB3aWxsIHNpbXBseSBsZXQgdGhlIGZ1bmN0aW9uKHMpIGJlbG93IHRoZW0gcGFyc2UsXG4vLyBhbmQsICppZiogdGhlIHN5bnRhY3RpYyBjb25zdHJ1Y3QgdGhleSBoYW5kbGUgaXMgcHJlc2VudCwgd3JhcFxuLy8gdGhlIEFTVCBub2RlIHRoYXQgdGhlIGlubmVyIHBhcnNlciBnYXZlIHRoZW0gaW4gYW5vdGhlciBub2RlLlxuLy8gUGFyc2UgYSBmdWxsIGV4cHJlc3Npb24uIFRoZSBvcHRpb25hbCBhcmd1bWVudHMgYXJlIHVzZWQgdG9cbi8vIGZvcmJpZCB0aGUgYGluYCBvcGVyYXRvciAoaW4gZm9yIGxvb3BzIGluaXRhbGl6YXRpb24gZXhwcmVzc2lvbnMpXG4vLyBhbmQgcHJvdmlkZSByZWZlcmVuY2UgZm9yIHN0b3JpbmcgJz0nIG9wZXJhdG9yIGluc2lkZSBzaG9ydGhhbmRcbi8vIHByb3BlcnR5IGFzc2lnbm1lbnQgaW4gY29udGV4dHMgd2hlcmUgYm90aCBvYmplY3QgZXhwcmVzc2lvblxuLy8gYW5kIG9iamVjdCBwYXR0ZXJuIG1pZ2h0IGFwcGVhciAoc28gaXQncyBwb3NzaWJsZSB0byByYWlzZVxuLy8gZGVsYXllZCBzeW50YXggZXJyb3IgYXQgY29ycmVjdCBwb3NpdGlvbikuXG5wcC5wYXJzZUV4cHJlc3Npb24gPSBmdW5jdGlvbihub0luLHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe3ZhciBzdGFydFBvcz10aGlzLnN0YXJ0LHN0YXJ0TG9jPXRoaXMuc3RhcnRMb2M7dmFyIGV4cHI9dGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmNvbW1hKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtub2RlLmV4cHJlc3Npb25zID0gW2V4cHJdO3doaWxlKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpKSBub2RlLmV4cHJlc3Npb25zLnB1c2godGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcykpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlNlcXVlbmNlRXhwcmVzc2lvblwiKTt9cmV0dXJuIGV4cHI7fTsgLy8gUGFyc2UgYW4gYXNzaWdubWVudCBleHByZXNzaW9uLiBUaGlzIGluY2x1ZGVzIGFwcGxpY2F0aW9ucyBvZlxuLy8gb3BlcmF0b3JzIGxpa2UgYCs9YC5cbnBwLnBhcnNlTWF5YmVBc3NpZ24gPSBmdW5jdGlvbihub0luLHJlZlNob3J0aGFuZERlZmF1bHRQb3MsYWZ0ZXJMZWZ0UGFyc2Upe2lmKHRoaXMudHlwZSA9PSBfdG9rZW50eXBlLnR5cGVzLl95aWVsZCAmJiB0aGlzLmluR2VuZXJhdG9yKXJldHVybiB0aGlzLnBhcnNlWWllbGQoKTt2YXIgZmFpbE9uU2hvcnRoYW5kQXNzaWduPXVuZGVmaW5lZDtpZighcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7cmVmU2hvcnRoYW5kRGVmYXVsdFBvcyA9IHtzdGFydDowfTtmYWlsT25TaG9ydGhhbmRBc3NpZ24gPSB0cnVlO31lbHNlIHtmYWlsT25TaG9ydGhhbmRBc3NpZ24gPSBmYWxzZTt9dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYztpZih0aGlzLnR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5wYXJlbkwgfHwgdGhpcy50eXBlID09IF90b2tlbnR5cGUudHlwZXMubmFtZSl0aGlzLnBvdGVudGlhbEFycm93QXQgPSB0aGlzLnN0YXJ0O3ZhciBsZWZ0PXRoaXMucGFyc2VNYXliZUNvbmRpdGlvbmFsKG5vSW4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7aWYoYWZ0ZXJMZWZ0UGFyc2UpbGVmdCA9IGFmdGVyTGVmdFBhcnNlLmNhbGwodGhpcyxsZWZ0LHN0YXJ0UG9zLHN0YXJ0TG9jKTtpZih0aGlzLnR5cGUuaXNBc3NpZ24pe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpO25vZGUub3BlcmF0b3IgPSB0aGlzLnZhbHVlO25vZGUubGVmdCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lcT90aGlzLnRvQXNzaWduYWJsZShsZWZ0KTpsZWZ0O3JlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQgPSAwOyAvLyByZXNldCBiZWNhdXNlIHNob3J0aGFuZCBkZWZhdWx0IHdhcyB1c2VkIGNvcnJlY3RseVxudGhpcy5jaGVja0xWYWwobGVmdCk7dGhpcy5uZXh0KCk7bm9kZS5yaWdodCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJBc3NpZ25tZW50RXhwcmVzc2lvblwiKTt9ZWxzZSBpZihmYWlsT25TaG9ydGhhbmRBc3NpZ24gJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCl7dGhpcy51bmV4cGVjdGVkKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpO31yZXR1cm4gbGVmdDt9OyAvLyBQYXJzZSBhIHRlcm5hcnkgY29uZGl0aW9uYWwgKGA/OmApIG9wZXJhdG9yLlxucHAucGFyc2VNYXliZUNvbmRpdGlvbmFsID0gZnVuY3Rpb24obm9JbixyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXt2YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBleHByPXRoaXMucGFyc2VFeHByT3BzKG5vSW4scmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7aWYocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyAmJiByZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KXJldHVybiBleHByO2lmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMucXVlc3Rpb24pKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtub2RlLnRlc3QgPSBleHByO25vZGUuY29uc2VxdWVudCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29sb24pO25vZGUuYWx0ZXJuYXRlID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4pO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkNvbmRpdGlvbmFsRXhwcmVzc2lvblwiKTt9cmV0dXJuIGV4cHI7fTsgLy8gU3RhcnQgdGhlIHByZWNlZGVuY2UgcGFyc2VyLlxucHAucGFyc2VFeHByT3BzID0gZnVuY3Rpb24obm9JbixyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXt2YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBleHByPXRoaXMucGFyc2VNYXliZVVuYXJ5KHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2lmKHJlZlNob3J0aGFuZERlZmF1bHRQb3MgJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydClyZXR1cm4gZXhwcjtyZXR1cm4gdGhpcy5wYXJzZUV4cHJPcChleHByLHN0YXJ0UG9zLHN0YXJ0TG9jLC0xLG5vSW4pO307IC8vIFBhcnNlIGJpbmFyeSBvcGVyYXRvcnMgd2l0aCB0aGUgb3BlcmF0b3IgcHJlY2VkZW5jZSBwYXJzaW5nXG4vLyBhbGdvcml0aG0uIGBsZWZ0YCBpcyB0aGUgbGVmdC1oYW5kIHNpZGUgb2YgdGhlIG9wZXJhdG9yLlxuLy8gYG1pblByZWNgIHByb3ZpZGVzIGNvbnRleHQgdGhhdCBhbGxvd3MgdGhlIGZ1bmN0aW9uIHRvIHN0b3AgYW5kXG4vLyBkZWZlciBmdXJ0aGVyIHBhcnNlciB0byBvbmUgb2YgaXRzIGNhbGxlcnMgd2hlbiBpdCBlbmNvdW50ZXJzIGFuXG4vLyBvcGVyYXRvciB0aGF0IGhhcyBhIGxvd2VyIHByZWNlZGVuY2UgdGhhbiB0aGUgc2V0IGl0IGlzIHBhcnNpbmcuXG5wcC5wYXJzZUV4cHJPcCA9IGZ1bmN0aW9uKGxlZnQsbGVmdFN0YXJ0UG9zLGxlZnRTdGFydExvYyxtaW5QcmVjLG5vSW4pe3ZhciBwcmVjPXRoaXMudHlwZS5iaW5vcDtpZihwcmVjICE9IG51bGwgJiYgKCFub0luIHx8IHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5faW4pKXtpZihwcmVjID4gbWluUHJlYyl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChsZWZ0U3RhcnRQb3MsbGVmdFN0YXJ0TG9jKTtub2RlLmxlZnQgPSBsZWZ0O25vZGUub3BlcmF0b3IgPSB0aGlzLnZhbHVlO3ZhciBvcD10aGlzLnR5cGU7dGhpcy5uZXh0KCk7dmFyIHN0YXJ0UG9zPXRoaXMuc3RhcnQsc3RhcnRMb2M9dGhpcy5zdGFydExvYztub2RlLnJpZ2h0ID0gdGhpcy5wYXJzZUV4cHJPcCh0aGlzLnBhcnNlTWF5YmVVbmFyeSgpLHN0YXJ0UG9zLHN0YXJ0TG9jLHByZWMsbm9Jbik7dGhpcy5maW5pc2hOb2RlKG5vZGUsb3AgPT09IF90b2tlbnR5cGUudHlwZXMubG9naWNhbE9SIHx8IG9wID09PSBfdG9rZW50eXBlLnR5cGVzLmxvZ2ljYWxBTkQ/XCJMb2dpY2FsRXhwcmVzc2lvblwiOlwiQmluYXJ5RXhwcmVzc2lvblwiKTtyZXR1cm4gdGhpcy5wYXJzZUV4cHJPcChub2RlLGxlZnRTdGFydFBvcyxsZWZ0U3RhcnRMb2MsbWluUHJlYyxub0luKTt9fXJldHVybiBsZWZ0O307IC8vIFBhcnNlIHVuYXJ5IG9wZXJhdG9ycywgYm90aCBwcmVmaXggYW5kIHBvc3RmaXguXG5wcC5wYXJzZU1heWJlVW5hcnkgPSBmdW5jdGlvbihyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXtpZih0aGlzLnR5cGUucHJlZml4KXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpLHVwZGF0ZT10aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuaW5jRGVjO25vZGUub3BlcmF0b3IgPSB0aGlzLnZhbHVlO25vZGUucHJlZml4ID0gdHJ1ZTt0aGlzLm5leHQoKTtub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlVW5hcnkoKTtpZihyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpdGhpcy51bmV4cGVjdGVkKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpO2lmKHVwZGF0ZSl0aGlzLmNoZWNrTFZhbChub2RlLmFyZ3VtZW50KTtlbHNlIGlmKHRoaXMuc3RyaWN0ICYmIG5vZGUub3BlcmF0b3IgPT09IFwiZGVsZXRlXCIgJiYgbm9kZS5hcmd1bWVudC50eXBlID09PSBcIklkZW50aWZpZXJcIil0aGlzLnJhaXNlKG5vZGUuc3RhcnQsXCJEZWxldGluZyBsb2NhbCB2YXJpYWJsZSBpbiBzdHJpY3QgbW9kZVwiKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsdXBkYXRlP1wiVXBkYXRlRXhwcmVzc2lvblwiOlwiVW5hcnlFeHByZXNzaW9uXCIpO312YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBleHByPXRoaXMucGFyc2VFeHByU3Vic2NyaXB0cyhyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtpZihyZWZTaG9ydGhhbmREZWZhdWx0UG9zICYmIHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpcmV0dXJuIGV4cHI7d2hpbGUodGhpcy50eXBlLnBvc3RmaXggJiYgIXRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkpIHt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtub2RlLm9wZXJhdG9yID0gdGhpcy52YWx1ZTtub2RlLnByZWZpeCA9IGZhbHNlO25vZGUuYXJndW1lbnQgPSBleHByO3RoaXMuY2hlY2tMVmFsKGV4cHIpO3RoaXMubmV4dCgpO2V4cHIgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlVwZGF0ZUV4cHJlc3Npb25cIik7fXJldHVybiBleHByO307IC8vIFBhcnNlIGNhbGwsIGRvdCwgYW5kIGBbXWAtc3Vic2NyaXB0IGV4cHJlc3Npb25zLlxucHAucGFyc2VFeHByU3Vic2NyaXB0cyA9IGZ1bmN0aW9uKHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe3ZhciBzdGFydFBvcz10aGlzLnN0YXJ0LHN0YXJ0TG9jPXRoaXMuc3RhcnRMb2M7dmFyIGV4cHI9dGhpcy5wYXJzZUV4cHJBdG9tKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2lmKHJlZlNob3J0aGFuZERlZmF1bHRQb3MgJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydClyZXR1cm4gZXhwcjtyZXR1cm4gdGhpcy5wYXJzZVN1YnNjcmlwdHMoZXhwcixzdGFydFBvcyxzdGFydExvYyk7fTtwcC5wYXJzZVN1YnNjcmlwdHMgPSBmdW5jdGlvbihiYXNlLHN0YXJ0UG9zLHN0YXJ0TG9jLG5vQ2FsbHMpe2Zvcig7Oykge2lmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuZG90KSl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS5vYmplY3QgPSBiYXNlO25vZGUucHJvcGVydHkgPSB0aGlzLnBhcnNlSWRlbnQodHJ1ZSk7bm9kZS5jb21wdXRlZCA9IGZhbHNlO2Jhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIk1lbWJlckV4cHJlc3Npb25cIik7fWVsc2UgaWYodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5icmFja2V0TCkpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpO25vZGUub2JqZWN0ID0gYmFzZTtub2RlLnByb3BlcnR5ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtub2RlLmNvbXB1dGVkID0gdHJ1ZTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJNZW1iZXJFeHByZXNzaW9uXCIpO31lbHNlIGlmKCFub0NhbGxzICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMucGFyZW5MKSl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS5jYWxsZWUgPSBiYXNlO25vZGUuYXJndW1lbnRzID0gdGhpcy5wYXJzZUV4cHJMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLGZhbHNlKTtiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJDYWxsRXhwcmVzc2lvblwiKTt9ZWxzZSBpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0UG9zLHN0YXJ0TG9jKTtub2RlLnRhZyA9IGJhc2U7bm9kZS5xdWFzaSA9IHRoaXMucGFyc2VUZW1wbGF0ZSgpO2Jhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlRhZ2dlZFRlbXBsYXRlRXhwcmVzc2lvblwiKTt9ZWxzZSB7cmV0dXJuIGJhc2U7fX19OyAvLyBQYXJzZSBhbiBhdG9taWMgZXhwcmVzc2lvbiDigJQgZWl0aGVyIGEgc2luZ2xlIHRva2VuIHRoYXQgaXMgYW5cbi8vIGV4cHJlc3Npb24sIGFuIGV4cHJlc3Npb24gc3RhcnRlZCBieSBhIGtleXdvcmQgbGlrZSBgZnVuY3Rpb25gIG9yXG4vLyBgbmV3YCwgb3IgYW4gZXhwcmVzc2lvbiB3cmFwcGVkIGluIHB1bmN0dWF0aW9uIGxpa2UgYCgpYCwgYFtdYCxcbi8vIG9yIGB7fWAuXG5wcC5wYXJzZUV4cHJBdG9tID0gZnVuY3Rpb24ocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7dmFyIG5vZGU9dW5kZWZpbmVkLGNhbkJlQXJyb3c9dGhpcy5wb3RlbnRpYWxBcnJvd0F0ID09IHRoaXMuc3RhcnQ7c3dpdGNoKHRoaXMudHlwZSl7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9zdXBlcjppZighdGhpcy5pbkZ1bmN0aW9uKXRoaXMucmFpc2UodGhpcy5zdGFydCxcIidzdXBlcicgb3V0c2lkZSBvZiBmdW5jdGlvbiBvciBjbGFzc1wiKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX3RoaXM6dmFyIHR5cGU9dGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl90aGlzP1wiVGhpc0V4cHJlc3Npb25cIjpcIlN1cGVyXCI7bm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLHR5cGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5feWllbGQ6aWYodGhpcy5pbkdlbmVyYXRvcil0aGlzLnVuZXhwZWN0ZWQoKTtjYXNlIF90b2tlbnR5cGUudHlwZXMubmFtZTp2YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBpZD10aGlzLnBhcnNlSWRlbnQodGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLm5hbWUpO2lmKGNhbkJlQXJyb3cgJiYgIXRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5hcnJvdykpcmV0dXJuIHRoaXMucGFyc2VBcnJvd0V4cHJlc3Npb24odGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyksW2lkXSk7cmV0dXJuIGlkO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5yZWdleHA6dmFyIHZhbHVlPXRoaXMudmFsdWU7bm9kZSA9IHRoaXMucGFyc2VMaXRlcmFsKHZhbHVlLnZhbHVlKTtub2RlLnJlZ2V4ID0ge3BhdHRlcm46dmFsdWUucGF0dGVybixmbGFnczp2YWx1ZS5mbGFnc307cmV0dXJuIG5vZGU7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLm51bTpjYXNlIF90b2tlbnR5cGUudHlwZXMuc3RyaW5nOnJldHVybiB0aGlzLnBhcnNlTGl0ZXJhbCh0aGlzLnZhbHVlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX251bGw6Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl90cnVlOmNhc2UgX3Rva2VudHlwZS50eXBlcy5fZmFsc2U6bm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7bm9kZS52YWx1ZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fbnVsbD9udWxsOnRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fdHJ1ZTtub2RlLnJhdyA9IHRoaXMudHlwZS5rZXl3b3JkO3RoaXMubmV4dCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkxpdGVyYWxcIik7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTDpyZXR1cm4gdGhpcy5wYXJzZVBhcmVuQW5kRGlzdGluZ3Vpc2hFeHByZXNzaW9uKGNhbkJlQXJyb3cpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5icmFja2V0TDpub2RlID0gdGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHQoKTsgLy8gY2hlY2sgd2hldGhlciB0aGlzIGlzIGFycmF5IGNvbXByZWhlbnNpb24gb3IgcmVndWxhciBhcnJheVxuaWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDcgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9mb3Ipe3JldHVybiB0aGlzLnBhcnNlQ29tcHJlaGVuc2lvbihub2RlLGZhbHNlKTt9bm9kZS5lbGVtZW50cyA9IHRoaXMucGFyc2VFeHByTGlzdChfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSLHRydWUsdHJ1ZSxyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJBcnJheUV4cHJlc3Npb25cIik7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDpyZXR1cm4gdGhpcy5wYXJzZU9iaihmYWxzZSxyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2Z1bmN0aW9uOm5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO3JldHVybiB0aGlzLnBhcnNlRnVuY3Rpb24obm9kZSxmYWxzZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9jbGFzczpyZXR1cm4gdGhpcy5wYXJzZUNsYXNzKHRoaXMuc3RhcnROb2RlKCksZmFsc2UpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fbmV3OnJldHVybiB0aGlzLnBhcnNlTmV3KCk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZTpyZXR1cm4gdGhpcy5wYXJzZVRlbXBsYXRlKCk7ZGVmYXVsdDp0aGlzLnVuZXhwZWN0ZWQoKTt9fTtwcC5wYXJzZUxpdGVyYWwgPSBmdW5jdGlvbih2YWx1ZSl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTtub2RlLnZhbHVlID0gdmFsdWU7bm9kZS5yYXcgPSB0aGlzLmlucHV0LnNsaWNlKHRoaXMuc3RhcnQsdGhpcy5lbmQpO3RoaXMubmV4dCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkxpdGVyYWxcIik7fTtwcC5wYXJzZVBhcmVuRXhwcmVzc2lvbiA9IGZ1bmN0aW9uKCl7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO3ZhciB2YWw9dGhpcy5wYXJzZUV4cHJlc3Npb24oKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7cmV0dXJuIHZhbDt9O3BwLnBhcnNlUGFyZW5BbmREaXN0aW5ndWlzaEV4cHJlc3Npb24gPSBmdW5jdGlvbihjYW5CZUFycm93KXt2YXIgc3RhcnRQb3M9dGhpcy5zdGFydCxzdGFydExvYz10aGlzLnN0YXJ0TG9jLHZhbD11bmRlZmluZWQ7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe3RoaXMubmV4dCgpO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA3ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZm9yKXtyZXR1cm4gdGhpcy5wYXJzZUNvbXByZWhlbnNpb24odGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyksdHJ1ZSk7fXZhciBpbm5lclN0YXJ0UG9zPXRoaXMuc3RhcnQsaW5uZXJTdGFydExvYz10aGlzLnN0YXJ0TG9jO3ZhciBleHByTGlzdD1bXSxmaXJzdD10cnVlO3ZhciByZWZTaG9ydGhhbmREZWZhdWx0UG9zPXtzdGFydDowfSxzcHJlYWRTdGFydD11bmRlZmluZWQsaW5uZXJQYXJlblN0YXJ0PXVuZGVmaW5lZDt3aGlsZSh0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5SKSB7Zmlyc3Q/Zmlyc3QgPSBmYWxzZTp0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpe3NwcmVhZFN0YXJ0ID0gdGhpcy5zdGFydDtleHByTGlzdC5wdXNoKHRoaXMucGFyc2VQYXJlbkl0ZW0odGhpcy5wYXJzZVJlc3QoKSkpO2JyZWFrO31lbHNlIHtpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMucGFyZW5MICYmICFpbm5lclBhcmVuU3RhcnQpe2lubmVyUGFyZW5TdGFydCA9IHRoaXMuc3RhcnQ7fWV4cHJMaXN0LnB1c2godGhpcy5wYXJzZU1heWJlQXNzaWduKGZhbHNlLHJlZlNob3J0aGFuZERlZmF1bHRQb3MsdGhpcy5wYXJzZVBhcmVuSXRlbSkpO319dmFyIGlubmVyRW5kUG9zPXRoaXMuc3RhcnQsaW5uZXJFbmRMb2M9dGhpcy5zdGFydExvYzt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7aWYoY2FuQmVBcnJvdyAmJiAhdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmFycm93KSl7aWYoaW5uZXJQYXJlblN0YXJ0KXRoaXMudW5leHBlY3RlZChpbm5lclBhcmVuU3RhcnQpO3JldHVybiB0aGlzLnBhcnNlUGFyZW5BcnJvd0xpc3Qoc3RhcnRQb3Msc3RhcnRMb2MsZXhwckxpc3QpO31pZighZXhwckxpc3QubGVuZ3RoKXRoaXMudW5leHBlY3RlZCh0aGlzLmxhc3RUb2tTdGFydCk7aWYoc3ByZWFkU3RhcnQpdGhpcy51bmV4cGVjdGVkKHNwcmVhZFN0YXJ0KTtpZihyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KXRoaXMudW5leHBlY3RlZChyZWZTaG9ydGhhbmREZWZhdWx0UG9zLnN0YXJ0KTtpZihleHByTGlzdC5sZW5ndGggPiAxKXt2YWwgPSB0aGlzLnN0YXJ0Tm9kZUF0KGlubmVyU3RhcnRQb3MsaW5uZXJTdGFydExvYyk7dmFsLmV4cHJlc3Npb25zID0gZXhwckxpc3Q7dGhpcy5maW5pc2hOb2RlQXQodmFsLFwiU2VxdWVuY2VFeHByZXNzaW9uXCIsaW5uZXJFbmRQb3MsaW5uZXJFbmRMb2MpO31lbHNlIHt2YWwgPSBleHByTGlzdFswXTt9fWVsc2Uge3ZhbCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTt9aWYodGhpcy5vcHRpb25zLnByZXNlcnZlUGFyZW5zKXt2YXIgcGFyPXRoaXMuc3RhcnROb2RlQXQoc3RhcnRQb3Msc3RhcnRMb2MpO3Bhci5leHByZXNzaW9uID0gdmFsO3JldHVybiB0aGlzLmZpbmlzaE5vZGUocGFyLFwiUGFyZW50aGVzaXplZEV4cHJlc3Npb25cIik7fWVsc2Uge3JldHVybiB2YWw7fX07cHAucGFyc2VQYXJlbkl0ZW0gPSBmdW5jdGlvbihpdGVtKXtyZXR1cm4gaXRlbTt9O3BwLnBhcnNlUGFyZW5BcnJvd0xpc3QgPSBmdW5jdGlvbihzdGFydFBvcyxzdGFydExvYyxleHByTGlzdCl7cmV0dXJuIHRoaXMucGFyc2VBcnJvd0V4cHJlc3Npb24odGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyksZXhwckxpc3QpO307IC8vIE5ldydzIHByZWNlZGVuY2UgaXMgc2xpZ2h0bHkgdHJpY2t5LiBJdCBtdXN0IGFsbG93IGl0cyBhcmd1bWVudFxuLy8gdG8gYmUgYSBgW11gIG9yIGRvdCBzdWJzY3JpcHQgZXhwcmVzc2lvbiwgYnV0IG5vdCBhIGNhbGwg4oCUIGF0XG4vLyBsZWFzdCwgbm90IHdpdGhvdXQgd3JhcHBpbmcgaXQgaW4gcGFyZW50aGVzZXMuIFRodXMsIGl0IHVzZXMgdGhlXG52YXIgZW1wdHk9W107cHAucGFyc2VOZXcgPSBmdW5jdGlvbigpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dmFyIG1ldGE9dGhpcy5wYXJzZUlkZW50KHRydWUpO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuZG90KSl7bm9kZS5tZXRhID0gbWV0YTtub2RlLnByb3BlcnR5ID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO2lmKG5vZGUucHJvcGVydHkubmFtZSAhPT0gXCJ0YXJnZXRcIil0aGlzLnJhaXNlKG5vZGUucHJvcGVydHkuc3RhcnQsXCJUaGUgb25seSB2YWxpZCBtZXRhIHByb3BlcnR5IGZvciBuZXcgaXMgbmV3LnRhcmdldFwiKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJNZXRhUHJvcGVydHlcIik7fXZhciBzdGFydFBvcz10aGlzLnN0YXJ0LHN0YXJ0TG9jPXRoaXMuc3RhcnRMb2M7bm9kZS5jYWxsZWUgPSB0aGlzLnBhcnNlU3Vic2NyaXB0cyh0aGlzLnBhcnNlRXhwckF0b20oKSxzdGFydFBvcyxzdGFydExvYyx0cnVlKTtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCkpbm9kZS5hcmd1bWVudHMgPSB0aGlzLnBhcnNlRXhwckxpc3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIsZmFsc2UpO2Vsc2Ugbm9kZS5hcmd1bWVudHMgPSBlbXB0eTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJOZXdFeHByZXNzaW9uXCIpO307IC8vIFBhcnNlIHRlbXBsYXRlIGV4cHJlc3Npb24uXG5wcC5wYXJzZVRlbXBsYXRlRWxlbWVudCA9IGZ1bmN0aW9uKCl7dmFyIGVsZW09dGhpcy5zdGFydE5vZGUoKTtlbGVtLnZhbHVlID0ge3Jhdzp0aGlzLmlucHV0LnNsaWNlKHRoaXMuc3RhcnQsdGhpcy5lbmQpLnJlcGxhY2UoL1xcclxcbj8vZywnXFxuJyksY29va2VkOnRoaXMudmFsdWV9O3RoaXMubmV4dCgpO2VsZW0udGFpbCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5iYWNrUXVvdGU7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShlbGVtLFwiVGVtcGxhdGVFbGVtZW50XCIpO307cHAucGFyc2VUZW1wbGF0ZSA9IGZ1bmN0aW9uKCl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHQoKTtub2RlLmV4cHJlc3Npb25zID0gW107dmFyIGN1ckVsdD10aGlzLnBhcnNlVGVtcGxhdGVFbGVtZW50KCk7bm9kZS5xdWFzaXMgPSBbY3VyRWx0XTt3aGlsZSghY3VyRWx0LnRhaWwpIHt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmRvbGxhckJyYWNlTCk7bm9kZS5leHByZXNzaW9ucy5wdXNoKHRoaXMucGFyc2VFeHByZXNzaW9uKCkpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKTtub2RlLnF1YXNpcy5wdXNoKGN1ckVsdCA9IHRoaXMucGFyc2VUZW1wbGF0ZUVsZW1lbnQoKSk7fXRoaXMubmV4dCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlRlbXBsYXRlTGl0ZXJhbFwiKTt9OyAvLyBQYXJzZSBhbiBvYmplY3QgbGl0ZXJhbCBvciBiaW5kaW5nIHBhdHRlcm4uXG5wcC5wYXJzZU9iaiA9IGZ1bmN0aW9uKGlzUGF0dGVybixyZWZTaG9ydGhhbmREZWZhdWx0UG9zKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpLGZpcnN0PXRydWUscHJvcEhhc2g9e307bm9kZS5wcm9wZXJ0aWVzID0gW107dGhpcy5uZXh0KCk7d2hpbGUoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge2lmKCFmaXJzdCl7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7aWYodGhpcy5hZnRlclRyYWlsaW5nQ29tbWEoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKWJyZWFrO31lbHNlIGZpcnN0ID0gZmFsc2U7dmFyIHByb3A9dGhpcy5zdGFydE5vZGUoKSxpc0dlbmVyYXRvcj11bmRlZmluZWQsc3RhcnRQb3M9dW5kZWZpbmVkLHN0YXJ0TG9jPXVuZGVmaW5lZDtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil7cHJvcC5tZXRob2QgPSBmYWxzZTtwcm9wLnNob3J0aGFuZCA9IGZhbHNlO2lmKGlzUGF0dGVybiB8fCByZWZTaG9ydGhhbmREZWZhdWx0UG9zKXtzdGFydFBvcyA9IHRoaXMuc3RhcnQ7c3RhcnRMb2MgPSB0aGlzLnN0YXJ0TG9jO31pZighaXNQYXR0ZXJuKWlzR2VuZXJhdG9yID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTt9dGhpcy5wYXJzZVByb3BlcnR5TmFtZShwcm9wKTt0aGlzLnBhcnNlUHJvcGVydHlWYWx1ZShwcm9wLGlzUGF0dGVybixpc0dlbmVyYXRvcixzdGFydFBvcyxzdGFydExvYyxyZWZTaG9ydGhhbmREZWZhdWx0UG9zKTt0aGlzLmNoZWNrUHJvcENsYXNoKHByb3AscHJvcEhhc2gpO25vZGUucHJvcGVydGllcy5wdXNoKHRoaXMuZmluaXNoTm9kZShwcm9wLFwiUHJvcGVydHlcIikpO31yZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsaXNQYXR0ZXJuP1wiT2JqZWN0UGF0dGVyblwiOlwiT2JqZWN0RXhwcmVzc2lvblwiKTt9O3BwLnBhcnNlUHJvcGVydHlWYWx1ZSA9IGZ1bmN0aW9uKHByb3AsaXNQYXR0ZXJuLGlzR2VuZXJhdG9yLHN0YXJ0UG9zLHN0YXJ0TG9jLHJlZlNob3J0aGFuZERlZmF1bHRQb3Mpe2lmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29sb24pKXtwcm9wLnZhbHVlID0gaXNQYXR0ZXJuP3RoaXMucGFyc2VNYXliZURlZmF1bHQodGhpcy5zdGFydCx0aGlzLnN0YXJ0TG9jKTp0aGlzLnBhcnNlTWF5YmVBc3NpZ24oZmFsc2UscmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7cHJvcC5raW5kID0gXCJpbml0XCI7fWVsc2UgaWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCl7aWYoaXNQYXR0ZXJuKXRoaXMudW5leHBlY3RlZCgpO3Byb3Aua2luZCA9IFwiaW5pdFwiO3Byb3AubWV0aG9kID0gdHJ1ZTtwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1ldGhvZChpc0dlbmVyYXRvcik7fWVsc2UgaWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDUgJiYgIXByb3AuY29tcHV0ZWQgJiYgcHJvcC5rZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgKHByb3Aua2V5Lm5hbWUgPT09IFwiZ2V0XCIgfHwgcHJvcC5rZXkubmFtZSA9PT0gXCJzZXRcIikgJiYgKHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLmNvbW1hICYmIHRoaXMudHlwZSAhPSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpe2lmKGlzR2VuZXJhdG9yIHx8IGlzUGF0dGVybil0aGlzLnVuZXhwZWN0ZWQoKTtwcm9wLmtpbmQgPSBwcm9wLmtleS5uYW1lO3RoaXMucGFyc2VQcm9wZXJ0eU5hbWUocHJvcCk7cHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoZmFsc2UpO3ZhciBwYXJhbUNvdW50PXByb3Aua2luZCA9PT0gXCJnZXRcIj8wOjE7aWYocHJvcC52YWx1ZS5wYXJhbXMubGVuZ3RoICE9PSBwYXJhbUNvdW50KXt2YXIgc3RhcnQ9cHJvcC52YWx1ZS5zdGFydDtpZihwcm9wLmtpbmQgPT09IFwiZ2V0XCIpdGhpcy5yYWlzZShzdGFydCxcImdldHRlciBzaG91bGQgaGF2ZSBubyBwYXJhbXNcIik7ZWxzZSB0aGlzLnJhaXNlKHN0YXJ0LFwic2V0dGVyIHNob3VsZCBoYXZlIGV4YWN0bHkgb25lIHBhcmFtXCIpO319ZWxzZSBpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiAhcHJvcC5jb21wdXRlZCAmJiBwcm9wLmtleS50eXBlID09PSBcIklkZW50aWZpZXJcIil7cHJvcC5raW5kID0gXCJpbml0XCI7aWYoaXNQYXR0ZXJuKXtpZih0aGlzLmlzS2V5d29yZChwcm9wLmtleS5uYW1lKSB8fCB0aGlzLnN0cmljdCAmJiAoX2lkZW50aWZpZXIucmVzZXJ2ZWRXb3Jkcy5zdHJpY3RCaW5kKHByb3Aua2V5Lm5hbWUpIHx8IF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0KHByb3Aua2V5Lm5hbWUpKSB8fCAhdGhpcy5vcHRpb25zLmFsbG93UmVzZXJ2ZWQgJiYgdGhpcy5pc1Jlc2VydmVkV29yZChwcm9wLmtleS5uYW1lKSl0aGlzLnJhaXNlKHByb3Aua2V5LnN0YXJ0LFwiQmluZGluZyBcIiArIHByb3Aua2V5Lm5hbWUpO3Byb3AudmFsdWUgPSB0aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHN0YXJ0UG9zLHN0YXJ0TG9jLHByb3Aua2V5KTt9ZWxzZSBpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZXEgJiYgcmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7aWYoIXJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpcmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCA9IHRoaXMuc3RhcnQ7cHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNYXliZURlZmF1bHQoc3RhcnRQb3Msc3RhcnRMb2MscHJvcC5rZXkpO31lbHNlIHtwcm9wLnZhbHVlID0gcHJvcC5rZXk7fXByb3Auc2hvcnRoYW5kID0gdHJ1ZTt9ZWxzZSB0aGlzLnVuZXhwZWN0ZWQoKTt9O3BwLnBhcnNlUHJvcGVydHlOYW1lID0gZnVuY3Rpb24ocHJvcCl7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe2lmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEwpKXtwcm9wLmNvbXB1dGVkID0gdHJ1ZTtwcm9wLmtleSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuYnJhY2tldFIpO3JldHVybiBwcm9wLmtleTt9ZWxzZSB7cHJvcC5jb21wdXRlZCA9IGZhbHNlO319cmV0dXJuIHByb3Aua2V5ID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLm51bSB8fCB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuc3RyaW5nP3RoaXMucGFyc2VFeHByQXRvbSgpOnRoaXMucGFyc2VJZGVudCh0cnVlKTt9OyAvLyBJbml0aWFsaXplIGVtcHR5IGZ1bmN0aW9uIG5vZGUuXG5wcC5pbml0RnVuY3Rpb24gPSBmdW5jdGlvbihub2RlKXtub2RlLmlkID0gbnVsbDtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil7bm9kZS5nZW5lcmF0b3IgPSBmYWxzZTtub2RlLmV4cHJlc3Npb24gPSBmYWxzZTt9fTsgLy8gUGFyc2Ugb2JqZWN0IG9yIGNsYXNzIG1ldGhvZC5cbnBwLnBhcnNlTWV0aG9kID0gZnVuY3Rpb24oaXNHZW5lcmF0b3Ipe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5pbml0RnVuY3Rpb24obm9kZSk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO25vZGUucGFyYW1zID0gdGhpcy5wYXJzZUJpbmRpbmdMaXN0KF90b2tlbnR5cGUudHlwZXMucGFyZW5SLGZhbHNlLGZhbHNlKTt2YXIgYWxsb3dFeHByZXNzaW9uQm9keT11bmRlZmluZWQ7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe25vZGUuZ2VuZXJhdG9yID0gaXNHZW5lcmF0b3I7fXRoaXMucGFyc2VGdW5jdGlvbkJvZHkobm9kZSxmYWxzZSk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiRnVuY3Rpb25FeHByZXNzaW9uXCIpO307IC8vIFBhcnNlIGFycm93IGZ1bmN0aW9uIGV4cHJlc3Npb24gd2l0aCBnaXZlbiBwYXJhbWV0ZXJzLlxucHAucGFyc2VBcnJvd0V4cHJlc3Npb24gPSBmdW5jdGlvbihub2RlLHBhcmFtcyl7dGhpcy5pbml0RnVuY3Rpb24obm9kZSk7bm9kZS5wYXJhbXMgPSB0aGlzLnRvQXNzaWduYWJsZUxpc3QocGFyYW1zLHRydWUpO3RoaXMucGFyc2VGdW5jdGlvbkJvZHkobm9kZSx0cnVlKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJBcnJvd0Z1bmN0aW9uRXhwcmVzc2lvblwiKTt9OyAvLyBQYXJzZSBmdW5jdGlvbiBib2R5IGFuZCBjaGVjayBwYXJhbWV0ZXJzLlxucHAucGFyc2VGdW5jdGlvbkJvZHkgPSBmdW5jdGlvbihub2RlLGFsbG93RXhwcmVzc2lvbil7dmFyIGlzRXhwcmVzc2lvbj1hbGxvd0V4cHJlc3Npb24gJiYgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlTDtpZihpc0V4cHJlc3Npb24pe25vZGUuYm9keSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO25vZGUuZXhwcmVzc2lvbiA9IHRydWU7fWVsc2UgeyAvLyBTdGFydCBhIG5ldyBzY29wZSB3aXRoIHJlZ2FyZCB0byBsYWJlbHMgYW5kIHRoZSBgaW5GdW5jdGlvbmBcbi8vIGZsYWcgKHJlc3RvcmUgdGhlbSB0byB0aGVpciBvbGQgdmFsdWUgYWZ0ZXJ3YXJkcykuXG52YXIgb2xkSW5GdW5jPXRoaXMuaW5GdW5jdGlvbixvbGRJbkdlbj10aGlzLmluR2VuZXJhdG9yLG9sZExhYmVscz10aGlzLmxhYmVsczt0aGlzLmluRnVuY3Rpb24gPSB0cnVlO3RoaXMuaW5HZW5lcmF0b3IgPSBub2RlLmdlbmVyYXRvcjt0aGlzLmxhYmVscyA9IFtdO25vZGUuYm9keSA9IHRoaXMucGFyc2VCbG9jayh0cnVlKTtub2RlLmV4cHJlc3Npb24gPSBmYWxzZTt0aGlzLmluRnVuY3Rpb24gPSBvbGRJbkZ1bmM7dGhpcy5pbkdlbmVyYXRvciA9IG9sZEluR2VuO3RoaXMubGFiZWxzID0gb2xkTGFiZWxzO30gLy8gSWYgdGhpcyBpcyBhIHN0cmljdCBtb2RlIGZ1bmN0aW9uLCB2ZXJpZnkgdGhhdCBhcmd1bWVudCBuYW1lc1xuLy8gYXJlIG5vdCByZXBlYXRlZCwgYW5kIGl0IGRvZXMgbm90IHRyeSB0byBiaW5kIHRoZSB3b3JkcyBgZXZhbGBcbi8vIG9yIGBhcmd1bWVudHNgLlxuaWYodGhpcy5zdHJpY3QgfHwgIWlzRXhwcmVzc2lvbiAmJiBub2RlLmJvZHkuYm9keS5sZW5ndGggJiYgdGhpcy5pc1VzZVN0cmljdChub2RlLmJvZHkuYm9keVswXSkpe3ZhciBuYW1lSGFzaD17fSxvbGRTdHJpY3Q9dGhpcy5zdHJpY3Q7dGhpcy5zdHJpY3QgPSB0cnVlO2lmKG5vZGUuaWQpdGhpcy5jaGVja0xWYWwobm9kZS5pZCx0cnVlKTtmb3IodmFyIGk9MDtpIDwgbm9kZS5wYXJhbXMubGVuZ3RoO2krKykge3RoaXMuY2hlY2tMVmFsKG5vZGUucGFyYW1zW2ldLHRydWUsbmFtZUhhc2gpO310aGlzLnN0cmljdCA9IG9sZFN0cmljdDt9fTsgLy8gUGFyc2VzIGEgY29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgZXhwcmVzc2lvbnMsIGFuZCByZXR1cm5zIHRoZW0gYXNcbi8vIGFuIGFycmF5LiBgY2xvc2VgIGlzIHRoZSB0b2tlbiB0eXBlIHRoYXQgZW5kcyB0aGUgbGlzdCwgYW5kXG4vLyBgYWxsb3dFbXB0eWAgY2FuIGJlIHR1cm5lZCBvbiB0byBhbGxvdyBzdWJzZXF1ZW50IGNvbW1hcyB3aXRoXG4vLyBub3RoaW5nIGluIGJldHdlZW4gdGhlbSB0byBiZSBwYXJzZWQgYXMgYG51bGxgICh3aGljaCBpcyBuZWVkZWRcbi8vIGZvciBhcnJheSBsaXRlcmFscykuXG5wcC5wYXJzZUV4cHJMaXN0ID0gZnVuY3Rpb24oY2xvc2UsYWxsb3dUcmFpbGluZ0NvbW1hLGFsbG93RW1wdHkscmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7dmFyIGVsdHM9W10sZmlyc3Q9dHJ1ZTt3aGlsZSghdGhpcy5lYXQoY2xvc2UpKSB7aWYoIWZpcnN0KXt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbW1hKTtpZihhbGxvd1RyYWlsaW5nQ29tbWEgJiYgdGhpcy5hZnRlclRyYWlsaW5nQ29tbWEoY2xvc2UpKWJyZWFrO31lbHNlIGZpcnN0ID0gZmFsc2U7dmFyIGVsdD11bmRlZmluZWQ7aWYoYWxsb3dFbXB0eSAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuY29tbWEpZWx0ID0gbnVsbDtlbHNlIGlmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lbGxpcHNpcyllbHQgPSB0aGlzLnBhcnNlU3ByZWFkKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2Vsc2UgZWx0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKGZhbHNlLHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO2VsdHMucHVzaChlbHQpO31yZXR1cm4gZWx0czt9OyAvLyBQYXJzZSB0aGUgbmV4dCB0b2tlbiBhcyBhbiBpZGVudGlmaWVyLiBJZiBgbGliZXJhbGAgaXMgdHJ1ZSAodXNlZFxuLy8gd2hlbiBwYXJzaW5nIHByb3BlcnRpZXMpLCBpdCB3aWxsIGFsc28gY29udmVydCBrZXl3b3JkcyBpbnRvXG4vLyBpZGVudGlmaWVycy5cbnBwLnBhcnNlSWRlbnQgPSBmdW5jdGlvbihsaWJlcmFsKXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO2lmKGxpYmVyYWwgJiYgdGhpcy5vcHRpb25zLmFsbG93UmVzZXJ2ZWQgPT0gXCJuZXZlclwiKWxpYmVyYWwgPSBmYWxzZTtpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSl7aWYoIWxpYmVyYWwgJiYgKCF0aGlzLm9wdGlvbnMuYWxsb3dSZXNlcnZlZCAmJiB0aGlzLmlzUmVzZXJ2ZWRXb3JkKHRoaXMudmFsdWUpIHx8IHRoaXMuc3RyaWN0ICYmIF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0KHRoaXMudmFsdWUpICYmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiB8fCB0aGlzLmlucHV0LnNsaWNlKHRoaXMuc3RhcnQsdGhpcy5lbmQpLmluZGV4T2YoXCJcXFxcXCIpID09IC0xKSkpdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LFwiVGhlIGtleXdvcmQgJ1wiICsgdGhpcy52YWx1ZSArIFwiJyBpcyByZXNlcnZlZFwiKTtub2RlLm5hbWUgPSB0aGlzLnZhbHVlO31lbHNlIGlmKGxpYmVyYWwgJiYgdGhpcy50eXBlLmtleXdvcmQpe25vZGUubmFtZSA9IHRoaXMudHlwZS5rZXl3b3JkO31lbHNlIHt0aGlzLnVuZXhwZWN0ZWQoKTt9dGhpcy5uZXh0KCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiSWRlbnRpZmllclwiKTt9OyAvLyBQYXJzZXMgeWllbGQgZXhwcmVzc2lvbiBpbnNpZGUgZ2VuZXJhdG9yLlxucHAucGFyc2VZaWVsZCA9IGZ1bmN0aW9uKCl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHQoKTtpZih0aGlzLnR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5zZW1pIHx8IHRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkgfHwgdGhpcy50eXBlICE9IF90b2tlbnR5cGUudHlwZXMuc3RhciAmJiAhdGhpcy50eXBlLnN0YXJ0c0V4cHIpe25vZGUuZGVsZWdhdGUgPSBmYWxzZTtub2RlLmFyZ3VtZW50ID0gbnVsbDt9ZWxzZSB7bm9kZS5kZWxlZ2F0ZSA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc3Rhcik7bm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO31yZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJZaWVsZEV4cHJlc3Npb25cIik7fTsgLy8gUGFyc2VzIGFycmF5IGFuZCBnZW5lcmF0b3IgY29tcHJlaGVuc2lvbnMuXG5wcC5wYXJzZUNvbXByZWhlbnNpb24gPSBmdW5jdGlvbihub2RlLGlzR2VuZXJhdG9yKXtub2RlLmJsb2NrcyA9IFtdO3doaWxlKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZm9yKSB7dmFyIGJsb2NrPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO2Jsb2NrLmxlZnQgPSB0aGlzLnBhcnNlQmluZGluZ0F0b20oKTt0aGlzLmNoZWNrTFZhbChibG9jay5sZWZ0LHRydWUpO3RoaXMuZXhwZWN0Q29udGV4dHVhbChcIm9mXCIpO2Jsb2NrLnJpZ2h0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7bm9kZS5ibG9ja3MucHVzaCh0aGlzLmZpbmlzaE5vZGUoYmxvY2ssXCJDb21wcmVoZW5zaW9uQmxvY2tcIikpO31ub2RlLmZpbHRlciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuX2lmKT90aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk6bnVsbDtub2RlLmJvZHkgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO3RoaXMuZXhwZWN0KGlzR2VuZXJhdG9yP190b2tlbnR5cGUudHlwZXMucGFyZW5SOl90b2tlbnR5cGUudHlwZXMuYnJhY2tldFIpO25vZGUuZ2VuZXJhdG9yID0gaXNHZW5lcmF0b3I7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiQ29tcHJlaGVuc2lvbkV4cHJlc3Npb25cIik7fTt9LHtcIi4vaWRlbnRpZmllclwiOjIsXCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi91dGlsXCI6MTV9XSwyOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXsgLy8gVGhpcyBpcyBhIHRyaWNrIHRha2VuIGZyb20gRXNwcmltYS4gSXQgdHVybnMgb3V0IHRoYXQsIG9uXG4vLyBub24tQ2hyb21lIGJyb3dzZXJzLCB0byBjaGVjayB3aGV0aGVyIGEgc3RyaW5nIGlzIGluIGEgc2V0LCBhXG4vLyBwcmVkaWNhdGUgY29udGFpbmluZyBhIGJpZyB1Z2x5IGBzd2l0Y2hgIHN0YXRlbWVudCBpcyBmYXN0ZXIgdGhhblxuLy8gYSByZWd1bGFyIGV4cHJlc3Npb24sIGFuZCBvbiBDaHJvbWUgdGhlIHR3byBhcmUgYWJvdXQgb24gcGFyLlxuLy8gVGhpcyBmdW5jdGlvbiB1c2VzIGBldmFsYCAobm9uLWxleGljYWwpIHRvIHByb2R1Y2Ugc3VjaCBhXG4vLyBwcmVkaWNhdGUgZnJvbSBhIHNwYWNlLXNlcGFyYXRlZCBzdHJpbmcgb2Ygd29yZHMuXG4vL1xuLy8gSXQgc3RhcnRzIGJ5IHNvcnRpbmcgdGhlIHdvcmRzIGJ5IGxlbmd0aC5cblwidXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZXhwb3J0cy5pc0lkZW50aWZpZXJTdGFydCA9IGlzSWRlbnRpZmllclN0YXJ0O2V4cG9ydHMuaXNJZGVudGlmaWVyQ2hhciA9IGlzSWRlbnRpZmllckNoYXI7ZnVuY3Rpb24gbWFrZVByZWRpY2F0ZSh3b3Jkcyl7d29yZHMgPSB3b3Jkcy5zcGxpdChcIiBcIik7dmFyIGY9XCJcIixjYXRzPVtdO291dDogZm9yKHZhciBpPTA7aSA8IHdvcmRzLmxlbmd0aDsrK2kpIHtmb3IodmFyIGo9MDtqIDwgY2F0cy5sZW5ndGg7KytqKSB7aWYoY2F0c1tqXVswXS5sZW5ndGggPT0gd29yZHNbaV0ubGVuZ3RoKXtjYXRzW2pdLnB1c2god29yZHNbaV0pO2NvbnRpbnVlIG91dDt9fWNhdHMucHVzaChbd29yZHNbaV1dKTt9ZnVuY3Rpb24gY29tcGFyZVRvKGFycil7aWYoYXJyLmxlbmd0aCA9PSAxKXJldHVybiBmICs9IFwicmV0dXJuIHN0ciA9PT0gXCIgKyBKU09OLnN0cmluZ2lmeShhcnJbMF0pICsgXCI7XCI7ZiArPSBcInN3aXRjaChzdHIpe1wiO2Zvcih2YXIgaT0wO2kgPCBhcnIubGVuZ3RoOysraSkge2YgKz0gXCJjYXNlIFwiICsgSlNPTi5zdHJpbmdpZnkoYXJyW2ldKSArIFwiOlwiO31mICs9IFwicmV0dXJuIHRydWV9cmV0dXJuIGZhbHNlO1wiO30gLy8gV2hlbiB0aGVyZSBhcmUgbW9yZSB0aGFuIHRocmVlIGxlbmd0aCBjYXRlZ29yaWVzLCBhbiBvdXRlclxuLy8gc3dpdGNoIGZpcnN0IGRpc3BhdGNoZXMgb24gdGhlIGxlbmd0aHMsIHRvIHNhdmUgb24gY29tcGFyaXNvbnMuXG5pZihjYXRzLmxlbmd0aCA+IDMpe2NhdHMuc29ydChmdW5jdGlvbihhLGIpe3JldHVybiBiLmxlbmd0aCAtIGEubGVuZ3RoO30pO2YgKz0gXCJzd2l0Y2goc3RyLmxlbmd0aCl7XCI7Zm9yKHZhciBpPTA7aSA8IGNhdHMubGVuZ3RoOysraSkge3ZhciBjYXQ9Y2F0c1tpXTtmICs9IFwiY2FzZSBcIiArIGNhdFswXS5sZW5ndGggKyBcIjpcIjtjb21wYXJlVG8oY2F0KTt9ZiArPSBcIn1cIjsgLy8gT3RoZXJ3aXNlLCBzaW1wbHkgZ2VuZXJhdGUgYSBmbGF0IGBzd2l0Y2hgIHN0YXRlbWVudC5cbn1lbHNlIHtjb21wYXJlVG8od29yZHMpO31yZXR1cm4gbmV3IEZ1bmN0aW9uKFwic3RyXCIsZik7fSAvLyBSZXNlcnZlZCB3b3JkIGxpc3RzIGZvciB2YXJpb3VzIGRpYWxlY3RzIG9mIHRoZSBsYW5ndWFnZVxudmFyIHJlc2VydmVkV29yZHM9ezM6bWFrZVByZWRpY2F0ZShcImFic3RyYWN0IGJvb2xlYW4gYnl0ZSBjaGFyIGNsYXNzIGRvdWJsZSBlbnVtIGV4cG9ydCBleHRlbmRzIGZpbmFsIGZsb2F0IGdvdG8gaW1wbGVtZW50cyBpbXBvcnQgaW50IGludGVyZmFjZSBsb25nIG5hdGl2ZSBwYWNrYWdlIHByaXZhdGUgcHJvdGVjdGVkIHB1YmxpYyBzaG9ydCBzdGF0aWMgc3VwZXIgc3luY2hyb25pemVkIHRocm93cyB0cmFuc2llbnQgdm9sYXRpbGVcIiksNTptYWtlUHJlZGljYXRlKFwiY2xhc3MgZW51bSBleHRlbmRzIHN1cGVyIGNvbnN0IGV4cG9ydCBpbXBvcnRcIiksNjptYWtlUHJlZGljYXRlKFwiZW51bSBhd2FpdFwiKSxzdHJpY3Q6bWFrZVByZWRpY2F0ZShcImltcGxlbWVudHMgaW50ZXJmYWNlIGxldCBwYWNrYWdlIHByaXZhdGUgcHJvdGVjdGVkIHB1YmxpYyBzdGF0aWMgeWllbGRcIiksc3RyaWN0QmluZDptYWtlUHJlZGljYXRlKFwiZXZhbCBhcmd1bWVudHNcIil9O2V4cG9ydHMucmVzZXJ2ZWRXb3JkcyA9IHJlc2VydmVkV29yZHM7IC8vIEFuZCB0aGUga2V5d29yZHNcbnZhciBlY21hNUFuZExlc3NLZXl3b3Jkcz1cImJyZWFrIGNhc2UgY2F0Y2ggY29udGludWUgZGVidWdnZXIgZGVmYXVsdCBkbyBlbHNlIGZpbmFsbHkgZm9yIGZ1bmN0aW9uIGlmIHJldHVybiBzd2l0Y2ggdGhyb3cgdHJ5IHZhciB3aGlsZSB3aXRoIG51bGwgdHJ1ZSBmYWxzZSBpbnN0YW5jZW9mIHR5cGVvZiB2b2lkIGRlbGV0ZSBuZXcgaW4gdGhpc1wiO3ZhciBrZXl3b3Jkcz17NTptYWtlUHJlZGljYXRlKGVjbWE1QW5kTGVzc0tleXdvcmRzKSw2Om1ha2VQcmVkaWNhdGUoZWNtYTVBbmRMZXNzS2V5d29yZHMgKyBcIiBsZXQgY29uc3QgY2xhc3MgZXh0ZW5kcyBleHBvcnQgaW1wb3J0IHlpZWxkIHN1cGVyXCIpfTtleHBvcnRzLmtleXdvcmRzID0ga2V5d29yZHM7IC8vICMjIENoYXJhY3RlciBjYXRlZ29yaWVzXG4vLyBCaWcgdWdseSByZWd1bGFyIGV4cHJlc3Npb25zIHRoYXQgbWF0Y2ggY2hhcmFjdGVycyBpbiB0aGVcbi8vIHdoaXRlc3BhY2UsIGlkZW50aWZpZXIsIGFuZCBpZGVudGlmaWVyLXN0YXJ0IGNhdGVnb3JpZXMuIFRoZXNlXG4vLyBhcmUgb25seSBhcHBsaWVkIHdoZW4gYSBjaGFyYWN0ZXIgaXMgZm91bmQgdG8gYWN0dWFsbHkgaGF2ZSBhXG4vLyBjb2RlIHBvaW50IGFib3ZlIDEyOC5cbi8vIEdlbmVyYXRlZCBieSBgdG9vbHMvZ2VuZXJhdGUtaWRlbnRpZmllci1yZWdleC5qc2AuXG52YXIgbm9uQVNDSUlpZGVudGlmaWVyU3RhcnRDaGFycz1cIsKqwrXCusOALcOWw5gtw7bDuC3LgcuGLcuRy6Aty6TLrMuuzbAtzbTNts23zbotzb3Nv86GzogtzorOjM6OLc6hzqMtz7XPty3SgdKKLdSv1LEt1ZbVmdWhLdaH15At16rXsC3XstigLdmK2a7Zr9mxLduT25Xbpdum267br9u6Ldu827/ckNySLdyv3Y0t3qXesd+KLd+q37Tftd+64KCALeCgleCgmuCgpOCgqOChgC3goZjgoqAt4KKy4KSELeCkueCkveClkOClmC3gpaHgpbEt4KaA4KaFLeCmjOCmj+CmkOCmky3gpqjgpqot4Kaw4Kay4Ka2LeCmueCmveCnjuCnnOCnneCnny3gp6Hgp7Dgp7HgqIUt4KiK4KiP4KiQ4KiTLeCoqOCoqi3gqLDgqLLgqLPgqLXgqLbgqLjgqLngqZkt4Kmc4Kme4KmyLeCptOCqhS3gqo3gqo8t4KqR4KqTLeCqqOCqqi3gqrDgqrLgqrPgqrUt4Kq54Kq94KuQ4Kug4Kuh4KyFLeCsjOCsj+CskOCsky3grKjgrKot4Kyw4Kyy4Kyz4Ky1LeCsueCsveCtnOCtneCtny3graHgrbHgroPgroUt4K6K4K6OLeCukOCuki3grpXgrpngrprgrpzgrp7grp/grqPgrqTgrqgt4K6q4K6uLeCuueCvkOCwhS3gsIzgsI4t4LCQ4LCSLeCwqOCwqi3gsLngsL3gsZjgsZngsaDgsaHgsoUt4LKM4LKOLeCykOCyki3gsqjgsqot4LKz4LK1LeCyueCyveCznuCzoOCzoeCzseCzsuC0hS3gtIzgtI4t4LSQ4LSSLeC0uuC0veC1juC1oOC1oeC1ui3gtb/gtoUt4LaW4LaaLeC2seC2sy3gtrvgtr3gt4At4LeG4LiBLeC4sOC4suC4s+C5gC3guYbguoHguoLguoTguofguojguorguo3gupQt4LqX4LqZLeC6n+C6oS3guqPguqXguqfguqrguqvguq0t4Lqw4Lqy4Lqz4Lq94LuALeC7hOC7huC7nC3gu5/gvIDgvYAt4L2H4L2JLeC9rOC+iC3gvozhgIAt4YCq4YC/4YGQLeGBleGBmi3hgZ3hgaHhgaXhgabhga4t4YGw4YG1LeGCgeGCjuGCoC3hg4Xhg4fhg43hg5At4YO64YO8LeGJiOGJii3hiY3hiZAt4YmW4YmY4YmaLeGJneGJoC3hiojhioot4YqN4YqQLeGKsOGKsi3hirXhirgt4Yq+4YuA4YuCLeGLheGLiC3hi5bhi5gt4YyQ4YySLeGMleGMmC3hjZrhjoAt4Y6P4Y6gLeGPtOGQgS3hmazhma8t4Zm/4ZqBLeGamuGaoC3hm6rhm64t4Zu44ZyALeGcjOGcji3hnJHhnKAt4Zyx4Z2ALeGdkeGdoC3hnazhna4t4Z2w4Z6ALeGes+Gfl+GfnOGgoC3hobfhooAt4aKo4aKq4aKwLeGjteGkgC3hpJ7hpZAt4aWt4aWwLeGltOGmgC3hpqvhp4Et4aeH4aiALeGoluGooC3hqZThqqfhrIUt4ayz4a2FLeGti+Gugy3hrqDhrq7hrq/hrrot4a+l4bCALeGwo+GxjS3hsY/hsZot4bG94bOpLeGzrOGzri3hs7Hhs7Xhs7bhtIAt4ba/4biALeG8leG8mC3hvJ3hvKAt4b2F4b2ILeG9jeG9kC3hvZfhvZnhvZvhvZ3hvZ8t4b294b6ALeG+tOG+ti3hvrzhvr7hv4It4b+E4b+GLeG/jOG/kC3hv5Phv5Yt4b+b4b+gLeG/rOG/si3hv7Thv7Yt4b+84oGx4oG/4oKQLeKCnOKEguKEh+KEii3ihJPihJXihJgt4oSd4oSk4oSm4oSo4oSqLeKEueKEvC3ihL/ihYUt4oWJ4oWO4oWgLeKGiOKwgC3isK7isLAt4rGe4rGgLeKzpOKzqy3is67is7Lis7PitIAt4rSl4rSn4rSt4rSwLeK1p+K1r+K2gC3itpbitqAt4ram4raoLeK2ruK2sC3itrbitrgt4ra+4reALeK3huK3iC3it47it5At4reW4reYLeK3nuOAhS3jgIfjgKEt44Cp44CxLeOAteOAuC3jgLzjgYEt44KW44KbLeOCn+OCoS3jg7rjg7wt44O/44SFLeOEreOEsS3jho7jhqAt44a644ewLeOHv+OQgC3ktrXkuIAt6b+M6oCALeqSjOqTkC3qk73qlIAt6piM6piQLeqYn+qYquqYq+qZgC3qma7qmb8t6pqd6pqgLeqbr+qcly3qnJ/qnKIt6p6I6p6LLeqejuqekC3qnq3qnrDqnrHqn7ct6qCB6qCDLeqgheqghy3qoIrqoIwt6qCi6qGALeqhs+qigi3qorPqo7It6qO36qO76qSKLeqkpeqksC3qpYbqpaAt6qW86qaELeqmsuqnj+qnoC3qp6Tqp6Yt6qev6qe6LeqnvuqogC3qqKjqqYAt6qmC6qmELeqpi+qpoC3qqbbqqbrqqb4t6qqv6qqx6qq16qq26qq5LeqqveqrgOqrguqrmy3qq53qq6At6quq6quyLeqrtOqsgS3qrIbqrIkt6qyO6qyRLeqsluqsoC3qrKbqrKgt6qyu6qywLeqtmuqtnC3qrZ/qraTqraXqr4At6q+i6rCALe2eo+2esC3tn4btn4st7Z+776SALe+pre+psC3vq5nvrIAt76yG76yTLe+sl++sne+sny3vrKjvrKot76y276y4Le+svO+svu+tgO+tge+tg++thO+thi3vrrHvr5Mt77S977WQLe+2j++2ki3vt4fvt7At77e777mwLe+5tO+5ti3vu7zvvKEt77y6772BLe+9mu+9pi3vvr7vv4It77+H77+KLe+/j++/ki3vv5fvv5ot77+cXCI7dmFyIG5vbkFTQ0lJaWRlbnRpZmllckNoYXJzPVwi4oCM4oCNwrfMgC3Nr86H0oMt0ofWkS3Wvda/14HXgteE14XXh9iQLdia2Yst2anZsNuWLduc258t26Tbp9uo26ot263bsC3budyR3LAt3Yrepi3esN+ALd+J36st37PgoJYt4KCZ4KCbLeCgo+CgpS3goKfgoKkt4KCt4KGZLeChm+CjpC3gpIPgpLot4KS84KS+LeClj+ClkS3gpZfgpaLgpaPgpaYt4KWv4KaBLeCmg+CmvOCmvi3gp4Tgp4fgp4jgp4st4KeN4KeX4Kei4Kej4KemLeCnr+CogS3gqIPgqLzgqL4t4KmC4KmH4KmI4KmLLeCpjeCpkeCppi3gqbHgqbXgqoEt4KqD4Kq84Kq+LeCrheCrhy3gq4ngq4st4KuN4Kui4Kuj4KumLeCrr+CsgS3grIPgrLzgrL4t4K2E4K2H4K2I4K2LLeCtjeCtluCtl+CtouCto+Ctpi3gra/groLgrr4t4K+C4K+GLeCviOCvii3gr43gr5fgr6Yt4K+v4LCALeCwg+Cwvi3gsYTgsYYt4LGI4LGKLeCxjeCxleCxluCxouCxo+Cxpi3gsa/gsoEt4LKD4LK84LK+LeCzhOCzhi3gs4jgs4ot4LON4LOV4LOW4LOi4LOj4LOmLeCzr+C0gS3gtIPgtL4t4LWE4LWGLeC1iOC1ii3gtY3gtZfgtaLgtaPgtaYt4LWv4LaC4LaD4LeK4LePLeC3lOC3luC3mC3gt5/gt6Yt4Lev4Ley4Lez4Lix4Li0LeC4uuC5hy3guY7guZAt4LmZ4Lqx4Lq0LeC6ueC6u+C6vOC7iC3gu43gu5At4LuZ4LyY4LyZ4LygLeC8qeC8teC8t+C8ueC8vuC8v+C9sS3gvoTgvobgvofgvo0t4L6X4L6ZLeC+vOC/huGAqy3hgL7hgYAt4YGJ4YGWLeGBmeGBni3hgaDhgaIt4YGk4YGnLeGBreGBsS3hgbThgoIt4YKN4YKPLeGCneGNnS3hjZ/hjakt4Y2x4ZySLeGclOGcsi3hnLThnZLhnZPhnbLhnbPhnrQt4Z+T4Z+d4Z+gLeGfqeGgiy3hoI3hoJAt4aCZ4aKp4aSgLeGkq+GksC3hpLvhpYYt4aWP4aawLeGngOGniOGnieGnkC3hp5rhqJct4aib4amVLeGpnuGpoC3hqbzhqb8t4aqJ4aqQLeGqmeGqsC3hqr3hrIAt4ayE4ay0LeGthOGtkC3hrZnhrast4a2z4a6ALeGuguGuoS3hrq3hrrAt4a654a+mLeGvs+GwpC3hsLfhsYAt4bGJ4bGQLeGxmeGzkC3hs5Lhs5Qt4bOo4bOt4bOyLeGztOGzuOGzueG3gC3ht7Xht7wt4be/4oC/4oGA4oGU4oOQLeKDnOKDoeKDpS3ig7Dis68t4rOx4rW/4regLeK3v+OAqi3jgK/jgpnjgprqmKAt6pip6pmv6pm0LeqZveqan+qbsOqbseqgguqghuqgi+qgoy3qoKfqooDqooHqorQt6qOE6qOQLeqjmeqjoC3qo7HqpIAt6qSJ6qSmLeqkreqlhy3qpZPqpoAt6qaD6qazLeqngOqnkC3qp5nqp6Xqp7At6qe56qipLeqotuqpg+qpjOqpjeqpkC3qqZnqqbst6qm96qqw6qqyLeqqtOqqt+qquOqqvuqqv+qrgeqrqy3qq6/qq7Xqq7bqr6Mt6q+q6q+s6q+t6q+wLeqvue+snu+4gC3vuI/vuKAt77it77iz77i077mNLe+5j++8kC3vvJnvvL9cIjt2YXIgbm9uQVNDSUlpZGVudGlmaWVyU3RhcnQ9bmV3IFJlZ0V4cChcIltcIiArIG5vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgKyBcIl1cIik7dmFyIG5vbkFTQ0lJaWRlbnRpZmllcj1uZXcgUmVnRXhwKFwiW1wiICsgbm9uQVNDSUlpZGVudGlmaWVyU3RhcnRDaGFycyArIG5vbkFTQ0lJaWRlbnRpZmllckNoYXJzICsgXCJdXCIpO25vbkFTQ0lJaWRlbnRpZmllclN0YXJ0Q2hhcnMgPSBub25BU0NJSWlkZW50aWZpZXJDaGFycyA9IG51bGw7IC8vIFRoZXNlIGFyZSBhIHJ1bi1sZW5ndGggYW5kIG9mZnNldCBlbmNvZGVkIHJlcHJlc2VudGF0aW9uIG9mIHRoZVxuLy8gPjB4ZmZmZiBjb2RlIHBvaW50cyB0aGF0IGFyZSBhIHZhbGlkIHBhcnQgb2YgaWRlbnRpZmllcnMuIFRoZVxuLy8gb2Zmc2V0IHN0YXJ0cyBhdCAweDEwMDAwLCBhbmQgZWFjaCBwYWlyIG9mIG51bWJlcnMgcmVwcmVzZW50cyBhblxuLy8gb2Zmc2V0IHRvIHRoZSBuZXh0IHJhbmdlLCBhbmQgdGhlbiBhIHNpemUgb2YgdGhlIHJhbmdlLiBUaGV5IHdlcmVcbi8vIGdlbmVyYXRlZCBieSB0b29scy9nZW5lcmF0ZS1pZGVudGlmaWVyLXJlZ2V4LmpzXG52YXIgYXN0cmFsSWRlbnRpZmllclN0YXJ0Q29kZXM9WzAsMTEsMiwyNSwyLDE4LDIsMSwyLDE0LDMsMTMsMzUsMTIyLDcwLDUyLDI2OCwyOCw0LDQ4LDQ4LDMxLDE3LDI2LDYsMzcsMTEsMjksMywzNSw1LDcsMiw0LDQzLDE1Nyw5OSwzOSw5LDUxLDE1NywzMTAsMTAsMjEsMTEsNywxNTMsNSwzLDAsMiw0MywyLDEsNCwwLDMsMjIsMTEsMjIsMTAsMzAsOTgsMjEsMTEsMjUsNzEsNTUsNywxLDY1LDAsMTYsMywyLDIsMiwyNiw0NSwyOCw0LDI4LDM2LDcsMiwyNywyOCw1MywxMSwyMSwxMSwxOCwxNCwxNywxMTEsNzIsOTU1LDUyLDc2LDQ0LDMzLDI0LDI3LDM1LDQyLDM0LDQsMCwxMyw0NywxNSwzLDIyLDAsMzgsMTcsMiwyNCwxMzMsNDYsMzksNywzLDEsMywyMSwyLDYsMiwxLDIsNCw0LDAsMzIsNCwyODcsNDcsMjEsMSwyLDAsMTg1LDQ2LDgyLDQ3LDIxLDAsNjAsNDIsNTAyLDYzLDMyLDAsNDQ5LDU2LDEyODgsOTIwLDEwNCwxMTAsMjk2MiwxMDcwLDEzMjY2LDU2OCw4LDMwLDExNCwyOSwxOSw0NywxNywzLDMyLDIwLDYsMTgsODgxLDY4LDEyLDAsNjcsMTIsMTY0ODEsMSwzMDcxLDEwNiw2LDEyLDQsOCw4LDksNTk5MSw4NCwyLDcwLDIsMSwzLDAsMywxLDMsMywyLDExLDIsMCwyLDYsMiw2NCwyLDMsMyw3LDIsNiwyLDI3LDIsMywyLDQsMiwwLDQsNiwyLDMzOSwzLDI0LDIsMjQsMiwzMCwyLDI0LDIsMzAsMiwyNCwyLDMwLDIsMjQsMiwzMCwyLDI0LDIsNyw0MTQ5LDE5NiwxMzQwLDMsMiwyNiwyLDEsMiwwLDMsMCwyLDksMiwzLDIsMCwyLDAsNywwLDUsMCwyLDAsMiwwLDIsMiwyLDEsMiwwLDMsMCwyLDAsMiwwLDIsMCwyLDAsMiwxLDIsMCwzLDMsMiw2LDIsMywyLDMsMiwwLDIsOSwyLDE2LDYsMiwyLDQsMiwxNiw0NDIxLDQyNzEwLDQyLDQxNDgsMTIsMjIxLDE2MzU1LDU0MV07dmFyIGFzdHJhbElkZW50aWZpZXJDb2Rlcz1bNTA5LDAsMjI3LDAsMTUwLDQsMjk0LDksMTM2OCwyLDIsMSw2LDMsNDEsMiw1LDAsMTY2LDEsMTMwNiwyLDU0LDE0LDMyLDksMTYsMyw0NiwxMCw1NCw5LDcsMiwzNywxMywyLDksNTIsMCwxMywyLDQ5LDEzLDE2LDksODMsMTEsMTY4LDExLDYsOSw4LDIsNTcsMCwyLDYsMywxLDMsMiwxMCwwLDExLDEsMyw2LDQsNCwzMTYsMTksMTMsOSwyMTQsNiwzLDgsMTEyLDE2LDE2LDksODIsMTIsOSw5LDUzNSw5LDIwODU1LDksMTM1LDQsNjAsNiwyNiw5LDEwMTYsNDUsMTcsMywxOTcyMywxLDUzMTksNCw0LDUsOSw3LDMsNiwzMSwzLDE0OSwyLDE0MTgsNDksNDMwNSw2LDc5MjYxOCwyMzldOyAvLyBUaGlzIGhhcyBhIGNvbXBsZXhpdHkgbGluZWFyIHRvIHRoZSB2YWx1ZSBvZiB0aGUgY29kZS4gVGhlXG4vLyBhc3N1bXB0aW9uIGlzIHRoYXQgbG9va2luZyB1cCBhc3RyYWwgaWRlbnRpZmllciBjaGFyYWN0ZXJzIGlzXG4vLyByYXJlLlxuZnVuY3Rpb24gaXNJbkFzdHJhbFNldChjb2RlLHNldCl7dmFyIHBvcz0weDEwMDAwO2Zvcih2YXIgaT0wO2kgPCBzZXQubGVuZ3RoO2kgKz0gMikge3BvcyArPSBzZXRbaV07aWYocG9zID4gY29kZSlyZXR1cm4gZmFsc2U7cG9zICs9IHNldFtpICsgMV07aWYocG9zID49IGNvZGUpcmV0dXJuIHRydWU7fX0gLy8gVGVzdCB3aGV0aGVyIGEgZ2l2ZW4gY2hhcmFjdGVyIGNvZGUgc3RhcnRzIGFuIGlkZW50aWZpZXIuXG5mdW5jdGlvbiBpc0lkZW50aWZpZXJTdGFydChjb2RlLGFzdHJhbCl7aWYoY29kZSA8IDY1KXJldHVybiBjb2RlID09PSAzNjtpZihjb2RlIDwgOTEpcmV0dXJuIHRydWU7aWYoY29kZSA8IDk3KXJldHVybiBjb2RlID09PSA5NTtpZihjb2RlIDwgMTIzKXJldHVybiB0cnVlO2lmKGNvZGUgPD0gMHhmZmZmKXJldHVybiBjb2RlID49IDB4YWEgJiYgbm9uQVNDSUlpZGVudGlmaWVyU3RhcnQudGVzdChTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpKTtpZihhc3RyYWwgPT09IGZhbHNlKXJldHVybiBmYWxzZTtyZXR1cm4gaXNJbkFzdHJhbFNldChjb2RlLGFzdHJhbElkZW50aWZpZXJTdGFydENvZGVzKTt9IC8vIFRlc3Qgd2hldGhlciBhIGdpdmVuIGNoYXJhY3RlciBpcyBwYXJ0IG9mIGFuIGlkZW50aWZpZXIuXG5mdW5jdGlvbiBpc0lkZW50aWZpZXJDaGFyKGNvZGUsYXN0cmFsKXtpZihjb2RlIDwgNDgpcmV0dXJuIGNvZGUgPT09IDM2O2lmKGNvZGUgPCA1OClyZXR1cm4gdHJ1ZTtpZihjb2RlIDwgNjUpcmV0dXJuIGZhbHNlO2lmKGNvZGUgPCA5MSlyZXR1cm4gdHJ1ZTtpZihjb2RlIDwgOTcpcmV0dXJuIGNvZGUgPT09IDk1O2lmKGNvZGUgPCAxMjMpcmV0dXJuIHRydWU7aWYoY29kZSA8PSAweGZmZmYpcmV0dXJuIGNvZGUgPj0gMHhhYSAmJiBub25BU0NJSWlkZW50aWZpZXIudGVzdChTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpKTtpZihhc3RyYWwgPT09IGZhbHNlKXJldHVybiBmYWxzZTtyZXR1cm4gaXNJbkFzdHJhbFNldChjb2RlLGFzdHJhbElkZW50aWZpZXJTdGFydENvZGVzKSB8fCBpc0luQXN0cmFsU2V0KGNvZGUsYXN0cmFsSWRlbnRpZmllckNvZGVzKTt9fSx7fV0sMzpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7IC8vIEFjb3JuIGlzIGEgdGlueSwgZmFzdCBKYXZhU2NyaXB0IHBhcnNlciB3cml0dGVuIGluIEphdmFTY3JpcHQuXG4vL1xuLy8gQWNvcm4gd2FzIHdyaXR0ZW4gYnkgTWFyaWpuIEhhdmVyYmVrZSwgSW5ndmFyIFN0ZXBhbnlhbiwgYW5kXG4vLyB2YXJpb3VzIGNvbnRyaWJ1dG9ycyBhbmQgcmVsZWFzZWQgdW5kZXIgYW4gTUlUIGxpY2Vuc2UuXG4vL1xuLy8gR2l0IHJlcG9zaXRvcmllcyBmb3IgQWNvcm4gYXJlIGF2YWlsYWJsZSBhdFxuLy9cbi8vICAgICBodHRwOi8vbWFyaWpuaGF2ZXJiZWtlLm5sL2dpdC9hY29yblxuLy8gICAgIGh0dHBzOi8vZ2l0aHViLmNvbS9tYXJpam5oL2Fjb3JuLmdpdFxuLy9cbi8vIFBsZWFzZSB1c2UgdGhlIFtnaXRodWIgYnVnIHRyYWNrZXJdW2doYnRdIHRvIHJlcG9ydCBpc3N1ZXMuXG4vL1xuLy8gW2doYnRdOiBodHRwczovL2dpdGh1Yi5jb20vbWFyaWpuaC9hY29ybi9pc3N1ZXNcbi8vXG4vLyBUaGlzIGZpbGUgZGVmaW5lcyB0aGUgbWFpbiBwYXJzZXIgaW50ZXJmYWNlLiBUaGUgbGlicmFyeSBhbHNvIGNvbWVzXG4vLyB3aXRoIGEgW2Vycm9yLXRvbGVyYW50IHBhcnNlcl1bZGFtbWl0XSBhbmQgYW5cbi8vIFthYnN0cmFjdCBzeW50YXggdHJlZSB3YWxrZXJdW3dhbGtdLCBkZWZpbmVkIGluIG90aGVyIGZpbGVzLlxuLy9cbi8vIFtkYW1taXRdOiBhY29ybl9sb29zZS5qc1xuLy8gW3dhbGtdOiB1dGlsL3dhbGsuanNcblwidXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZXhwb3J0cy5wYXJzZSA9IHBhcnNlO2V4cG9ydHMucGFyc2VFeHByZXNzaW9uQXQgPSBwYXJzZUV4cHJlc3Npb25BdDtleHBvcnRzLnRva2VuaXplciA9IHRva2VuaXplcjt2YXIgX3N0YXRlPV9kZXJlcV8oXCIuL3N0YXRlXCIpO3ZhciBfb3B0aW9ucz1fZGVyZXFfKFwiLi9vcHRpb25zXCIpO19kZXJlcV8oXCIuL3BhcnNldXRpbFwiKTtfZGVyZXFfKFwiLi9zdGF0ZW1lbnRcIik7X2RlcmVxXyhcIi4vbHZhbFwiKTtfZGVyZXFfKFwiLi9leHByZXNzaW9uXCIpO19kZXJlcV8oXCIuL2xvY2F0aW9uXCIpO2V4cG9ydHMuUGFyc2VyID0gX3N0YXRlLlBhcnNlcjtleHBvcnRzLnBsdWdpbnMgPSBfc3RhdGUucGx1Z2lucztleHBvcnRzLmRlZmF1bHRPcHRpb25zID0gX29wdGlvbnMuZGVmYXVsdE9wdGlvbnM7dmFyIF9sb2N1dGlsPV9kZXJlcV8oXCIuL2xvY3V0aWxcIik7ZXhwb3J0cy5Qb3NpdGlvbiA9IF9sb2N1dGlsLlBvc2l0aW9uO2V4cG9ydHMuU291cmNlTG9jYXRpb24gPSBfbG9jdXRpbC5Tb3VyY2VMb2NhdGlvbjtleHBvcnRzLmdldExpbmVJbmZvID0gX2xvY3V0aWwuZ2V0TGluZUluZm87dmFyIF9ub2RlPV9kZXJlcV8oXCIuL25vZGVcIik7ZXhwb3J0cy5Ob2RlID0gX25vZGUuTm9kZTt2YXIgX3Rva2VudHlwZT1fZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7ZXhwb3J0cy5Ub2tlblR5cGUgPSBfdG9rZW50eXBlLlRva2VuVHlwZTtleHBvcnRzLnRva1R5cGVzID0gX3Rva2VudHlwZS50eXBlczt2YXIgX3Rva2VuY29udGV4dD1fZGVyZXFfKFwiLi90b2tlbmNvbnRleHRcIik7ZXhwb3J0cy5Ub2tDb250ZXh0ID0gX3Rva2VuY29udGV4dC5Ub2tDb250ZXh0O2V4cG9ydHMudG9rQ29udGV4dHMgPSBfdG9rZW5jb250ZXh0LnR5cGVzO3ZhciBfaWRlbnRpZmllcj1fZGVyZXFfKFwiLi9pZGVudGlmaWVyXCIpO2V4cG9ydHMuaXNJZGVudGlmaWVyQ2hhciA9IF9pZGVudGlmaWVyLmlzSWRlbnRpZmllckNoYXI7ZXhwb3J0cy5pc0lkZW50aWZpZXJTdGFydCA9IF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0O3ZhciBfdG9rZW5pemU9X2RlcmVxXyhcIi4vdG9rZW5pemVcIik7ZXhwb3J0cy5Ub2tlbiA9IF90b2tlbml6ZS5Ub2tlbjt2YXIgX3doaXRlc3BhY2U9X2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTtleHBvcnRzLmlzTmV3TGluZSA9IF93aGl0ZXNwYWNlLmlzTmV3TGluZTtleHBvcnRzLmxpbmVCcmVhayA9IF93aGl0ZXNwYWNlLmxpbmVCcmVhaztleHBvcnRzLmxpbmVCcmVha0cgPSBfd2hpdGVzcGFjZS5saW5lQnJlYWtHO3ZhciB2ZXJzaW9uPVwiMi4yLjBcIjtleHBvcnRzLnZlcnNpb24gPSB2ZXJzaW9uOyAvLyBUaGUgbWFpbiBleHBvcnRlZCBpbnRlcmZhY2UgKHVuZGVyIGBzZWxmLmFjb3JuYCB3aGVuIGluIHRoZVxuLy8gYnJvd3NlcikgaXMgYSBgcGFyc2VgIGZ1bmN0aW9uIHRoYXQgdGFrZXMgYSBjb2RlIHN0cmluZyBhbmRcbi8vIHJldHVybnMgYW4gYWJzdHJhY3Qgc3ludGF4IHRyZWUgYXMgc3BlY2lmaWVkIGJ5IFtNb3ppbGxhIHBhcnNlclxuLy8gQVBJXVthcGldLlxuLy9cbi8vIFthcGldOiBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1NwaWRlck1vbmtleS9QYXJzZXJfQVBJXG5mdW5jdGlvbiBwYXJzZShpbnB1dCxvcHRpb25zKXtyZXR1cm4gbmV3IF9zdGF0ZS5QYXJzZXIob3B0aW9ucyxpbnB1dCkucGFyc2UoKTt9IC8vIFRoaXMgZnVuY3Rpb24gdHJpZXMgdG8gcGFyc2UgYSBzaW5nbGUgZXhwcmVzc2lvbiBhdCBhIGdpdmVuXG4vLyBvZmZzZXQgaW4gYSBzdHJpbmcuIFVzZWZ1bCBmb3IgcGFyc2luZyBtaXhlZC1sYW5ndWFnZSBmb3JtYXRzXG4vLyB0aGF0IGVtYmVkIEphdmFTY3JpcHQgZXhwcmVzc2lvbnMuXG5mdW5jdGlvbiBwYXJzZUV4cHJlc3Npb25BdChpbnB1dCxwb3Msb3B0aW9ucyl7dmFyIHA9bmV3IF9zdGF0ZS5QYXJzZXIob3B0aW9ucyxpbnB1dCxwb3MpO3AubmV4dFRva2VuKCk7cmV0dXJuIHAucGFyc2VFeHByZXNzaW9uKCk7fSAvLyBBY29ybiBpcyBvcmdhbml6ZWQgYXMgYSB0b2tlbml6ZXIgYW5kIGEgcmVjdXJzaXZlLWRlc2NlbnQgcGFyc2VyLlxuLy8gVGhlIGB0b2tlbml6ZWAgZXhwb3J0IHByb3ZpZGVzIGFuIGludGVyZmFjZSB0byB0aGUgdG9rZW5pemVyLlxuZnVuY3Rpb24gdG9rZW5pemVyKGlucHV0LG9wdGlvbnMpe3JldHVybiBuZXcgX3N0YXRlLlBhcnNlcihvcHRpb25zLGlucHV0KTt9fSx7XCIuL2V4cHJlc3Npb25cIjoxLFwiLi9pZGVudGlmaWVyXCI6MixcIi4vbG9jYXRpb25cIjo0LFwiLi9sb2N1dGlsXCI6NSxcIi4vbHZhbFwiOjYsXCIuL25vZGVcIjo3LFwiLi9vcHRpb25zXCI6OCxcIi4vcGFyc2V1dGlsXCI6OSxcIi4vc3RhdGVcIjoxMCxcIi4vc3RhdGVtZW50XCI6MTEsXCIuL3Rva2VuY29udGV4dFwiOjEyLFwiLi90b2tlbml6ZVwiOjEzLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sNDpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX2xvY3V0aWw9X2RlcmVxXyhcIi4vbG9jdXRpbFwiKTt2YXIgcHA9X3N0YXRlLlBhcnNlci5wcm90b3R5cGU7IC8vIFRoaXMgZnVuY3Rpb24gaXMgdXNlZCB0byByYWlzZSBleGNlcHRpb25zIG9uIHBhcnNlIGVycm9ycy4gSXRcbi8vIHRha2VzIGFuIG9mZnNldCBpbnRlZ2VyIChpbnRvIHRoZSBjdXJyZW50IGBpbnB1dGApIHRvIGluZGljYXRlXG4vLyB0aGUgbG9jYXRpb24gb2YgdGhlIGVycm9yLCBhdHRhY2hlcyB0aGUgcG9zaXRpb24gdG8gdGhlIGVuZFxuLy8gb2YgdGhlIGVycm9yIG1lc3NhZ2UsIGFuZCB0aGVuIHJhaXNlcyBhIGBTeW50YXhFcnJvcmAgd2l0aCB0aGF0XG4vLyBtZXNzYWdlLlxucHAucmFpc2UgPSBmdW5jdGlvbihwb3MsbWVzc2FnZSl7dmFyIGxvYz1fbG9jdXRpbC5nZXRMaW5lSW5mbyh0aGlzLmlucHV0LHBvcyk7bWVzc2FnZSArPSBcIiAoXCIgKyBsb2MubGluZSArIFwiOlwiICsgbG9jLmNvbHVtbiArIFwiKVwiO3ZhciBlcnI9bmV3IFN5bnRheEVycm9yKG1lc3NhZ2UpO2Vyci5wb3MgPSBwb3M7ZXJyLmxvYyA9IGxvYztlcnIucmFpc2VkQXQgPSB0aGlzLnBvczt0aHJvdyBlcnI7fTtwcC5jdXJQb3NpdGlvbiA9IGZ1bmN0aW9uKCl7aWYodGhpcy5vcHRpb25zLmxvY2F0aW9ucyl7cmV0dXJuIG5ldyBfbG9jdXRpbC5Qb3NpdGlvbih0aGlzLmN1ckxpbmUsdGhpcy5wb3MgLSB0aGlzLmxpbmVTdGFydCk7fX07fSx7XCIuL2xvY3V0aWxcIjo1LFwiLi9zdGF0ZVwiOjEwfV0sNTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtleHBvcnRzLmdldExpbmVJbmZvID0gZ2V0TGluZUluZm87ZnVuY3Rpb24gX2NsYXNzQ2FsbENoZWNrKGluc3RhbmNlLENvbnN0cnVjdG9yKXtpZighKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKXt0aHJvdyBuZXcgVHlwZUVycm9yKFwiQ2Fubm90IGNhbGwgYSBjbGFzcyBhcyBhIGZ1bmN0aW9uXCIpO319dmFyIF93aGl0ZXNwYWNlPV9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7IC8vIFRoZXNlIGFyZSB1c2VkIHdoZW4gYG9wdGlvbnMubG9jYXRpb25zYCBpcyBvbiwgZm9yIHRoZVxuLy8gYHN0YXJ0TG9jYCBhbmQgYGVuZExvY2AgcHJvcGVydGllcy5cbnZhciBQb3NpdGlvbj0oZnVuY3Rpb24oKXtmdW5jdGlvbiBQb3NpdGlvbihsaW5lLGNvbCl7X2NsYXNzQ2FsbENoZWNrKHRoaXMsUG9zaXRpb24pO3RoaXMubGluZSA9IGxpbmU7dGhpcy5jb2x1bW4gPSBjb2w7fVBvc2l0aW9uLnByb3RvdHlwZS5vZmZzZXQgPSBmdW5jdGlvbiBvZmZzZXQobil7cmV0dXJuIG5ldyBQb3NpdGlvbih0aGlzLmxpbmUsdGhpcy5jb2x1bW4gKyBuKTt9O3JldHVybiBQb3NpdGlvbjt9KSgpO2V4cG9ydHMuUG9zaXRpb24gPSBQb3NpdGlvbjt2YXIgU291cmNlTG9jYXRpb249ZnVuY3Rpb24gU291cmNlTG9jYXRpb24ocCxzdGFydCxlbmQpe19jbGFzc0NhbGxDaGVjayh0aGlzLFNvdXJjZUxvY2F0aW9uKTt0aGlzLnN0YXJ0ID0gc3RhcnQ7dGhpcy5lbmQgPSBlbmQ7aWYocC5zb3VyY2VGaWxlICE9PSBudWxsKXRoaXMuc291cmNlID0gcC5zb3VyY2VGaWxlO30gLy8gVGhlIGBnZXRMaW5lSW5mb2AgZnVuY3Rpb24gaXMgbW9zdGx5IHVzZWZ1bCB3aGVuIHRoZVxuLy8gYGxvY2F0aW9uc2Agb3B0aW9uIGlzIG9mZiAoZm9yIHBlcmZvcm1hbmNlIHJlYXNvbnMpIGFuZCB5b3Vcbi8vIHdhbnQgdG8gZmluZCB0aGUgbGluZS9jb2x1bW4gcG9zaXRpb24gZm9yIGEgZ2l2ZW4gY2hhcmFjdGVyXG4vLyBvZmZzZXQuIGBpbnB1dGAgc2hvdWxkIGJlIHRoZSBjb2RlIHN0cmluZyB0aGF0IHRoZSBvZmZzZXQgcmVmZXJzXG4vLyBpbnRvLlxuO2V4cG9ydHMuU291cmNlTG9jYXRpb24gPSBTb3VyY2VMb2NhdGlvbjtmdW5jdGlvbiBnZXRMaW5lSW5mbyhpbnB1dCxvZmZzZXQpe2Zvcih2YXIgbGluZT0xLGN1cj0wOzspIHtfd2hpdGVzcGFjZS5saW5lQnJlYWtHLmxhc3RJbmRleCA9IGN1cjt2YXIgbWF0Y2g9X3doaXRlc3BhY2UubGluZUJyZWFrRy5leGVjKGlucHV0KTtpZihtYXRjaCAmJiBtYXRjaC5pbmRleCA8IG9mZnNldCl7KytsaW5lO2N1ciA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO31lbHNlIHtyZXR1cm4gbmV3IFBvc2l0aW9uKGxpbmUsb2Zmc2V0IC0gY3VyKTt9fX19LHtcIi4vd2hpdGVzcGFjZVwiOjE2fV0sNjpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7dmFyIF90b2tlbnR5cGU9X2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO3ZhciBfc3RhdGU9X2RlcmVxXyhcIi4vc3RhdGVcIik7dmFyIF9pZGVudGlmaWVyPV9kZXJlcV8oXCIuL2lkZW50aWZpZXJcIik7dmFyIF91dGlsPV9kZXJlcV8oXCIuL3V0aWxcIik7dmFyIHBwPV9zdGF0ZS5QYXJzZXIucHJvdG90eXBlOyAvLyBDb252ZXJ0IGV4aXN0aW5nIGV4cHJlc3Npb24gYXRvbSB0byBhc3NpZ25hYmxlIHBhdHRlcm5cbi8vIGlmIHBvc3NpYmxlLlxucHAudG9Bc3NpZ25hYmxlID0gZnVuY3Rpb24obm9kZSxpc0JpbmRpbmcpe2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIG5vZGUpe3N3aXRjaChub2RlLnR5cGUpe2Nhc2UgXCJJZGVudGlmaWVyXCI6Y2FzZSBcIk9iamVjdFBhdHRlcm5cIjpjYXNlIFwiQXJyYXlQYXR0ZXJuXCI6Y2FzZSBcIkFzc2lnbm1lbnRQYXR0ZXJuXCI6YnJlYWs7Y2FzZSBcIk9iamVjdEV4cHJlc3Npb25cIjpub2RlLnR5cGUgPSBcIk9iamVjdFBhdHRlcm5cIjtmb3IodmFyIGk9MDtpIDwgbm9kZS5wcm9wZXJ0aWVzLmxlbmd0aDtpKyspIHt2YXIgcHJvcD1ub2RlLnByb3BlcnRpZXNbaV07aWYocHJvcC5raW5kICE9PSBcImluaXRcIil0aGlzLnJhaXNlKHByb3Aua2V5LnN0YXJ0LFwiT2JqZWN0IHBhdHRlcm4gY2FuJ3QgY29udGFpbiBnZXR0ZXIgb3Igc2V0dGVyXCIpO3RoaXMudG9Bc3NpZ25hYmxlKHByb3AudmFsdWUsaXNCaW5kaW5nKTt9YnJlYWs7Y2FzZSBcIkFycmF5RXhwcmVzc2lvblwiOm5vZGUudHlwZSA9IFwiQXJyYXlQYXR0ZXJuXCI7dGhpcy50b0Fzc2lnbmFibGVMaXN0KG5vZGUuZWxlbWVudHMsaXNCaW5kaW5nKTticmVhaztjYXNlIFwiQXNzaWdubWVudEV4cHJlc3Npb25cIjppZihub2RlLm9wZXJhdG9yID09PSBcIj1cIil7bm9kZS50eXBlID0gXCJBc3NpZ25tZW50UGF0dGVyblwiO2RlbGV0ZSBub2RlLm9wZXJhdG9yO31lbHNlIHt0aGlzLnJhaXNlKG5vZGUubGVmdC5lbmQsXCJPbmx5ICc9JyBvcGVyYXRvciBjYW4gYmUgdXNlZCBmb3Igc3BlY2lmeWluZyBkZWZhdWx0IHZhbHVlLlwiKTt9YnJlYWs7Y2FzZSBcIlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uXCI6bm9kZS5leHByZXNzaW9uID0gdGhpcy50b0Fzc2lnbmFibGUobm9kZS5leHByZXNzaW9uLGlzQmluZGluZyk7YnJlYWs7Y2FzZSBcIk1lbWJlckV4cHJlc3Npb25cIjppZighaXNCaW5kaW5nKWJyZWFrO2RlZmF1bHQ6dGhpcy5yYWlzZShub2RlLnN0YXJ0LFwiQXNzaWduaW5nIHRvIHJ2YWx1ZVwiKTt9fXJldHVybiBub2RlO307IC8vIENvbnZlcnQgbGlzdCBvZiBleHByZXNzaW9uIGF0b21zIHRvIGJpbmRpbmcgbGlzdC5cbnBwLnRvQXNzaWduYWJsZUxpc3QgPSBmdW5jdGlvbihleHByTGlzdCxpc0JpbmRpbmcpe3ZhciBlbmQ9ZXhwckxpc3QubGVuZ3RoO2lmKGVuZCl7dmFyIGxhc3Q9ZXhwckxpc3RbZW5kIC0gMV07aWYobGFzdCAmJiBsYXN0LnR5cGUgPT0gXCJSZXN0RWxlbWVudFwiKXstLWVuZDt9ZWxzZSBpZihsYXN0ICYmIGxhc3QudHlwZSA9PSBcIlNwcmVhZEVsZW1lbnRcIil7bGFzdC50eXBlID0gXCJSZXN0RWxlbWVudFwiO3ZhciBhcmc9bGFzdC5hcmd1bWVudDt0aGlzLnRvQXNzaWduYWJsZShhcmcsaXNCaW5kaW5nKTtpZihhcmcudHlwZSAhPT0gXCJJZGVudGlmaWVyXCIgJiYgYXJnLnR5cGUgIT09IFwiTWVtYmVyRXhwcmVzc2lvblwiICYmIGFyZy50eXBlICE9PSBcIkFycmF5UGF0dGVyblwiKXRoaXMudW5leHBlY3RlZChhcmcuc3RhcnQpOy0tZW5kO319Zm9yKHZhciBpPTA7aSA8IGVuZDtpKyspIHt2YXIgZWx0PWV4cHJMaXN0W2ldO2lmKGVsdCl0aGlzLnRvQXNzaWduYWJsZShlbHQsaXNCaW5kaW5nKTt9cmV0dXJuIGV4cHJMaXN0O307IC8vIFBhcnNlcyBzcHJlYWQgZWxlbWVudC5cbnBwLnBhcnNlU3ByZWFkID0gZnVuY3Rpb24ocmVmU2hvcnRoYW5kRGVmYXVsdFBvcyl7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTt0aGlzLm5leHQoKTtub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKHJlZlNob3J0aGFuZERlZmF1bHRQb3MpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlNwcmVhZEVsZW1lbnRcIik7fTtwcC5wYXJzZVJlc3QgPSBmdW5jdGlvbigpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7bm9kZS5hcmd1bWVudCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5icmFja2V0TD90aGlzLnBhcnNlQmluZGluZ0F0b20oKTp0aGlzLnVuZXhwZWN0ZWQoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJSZXN0RWxlbWVudFwiKTt9OyAvLyBQYXJzZXMgbHZhbHVlIChhc3NpZ25hYmxlKSBhdG9tLlxucHAucGFyc2VCaW5kaW5nQXRvbSA9IGZ1bmN0aW9uKCl7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uIDwgNilyZXR1cm4gdGhpcy5wYXJzZUlkZW50KCk7c3dpdGNoKHRoaXMudHlwZSl7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLm5hbWU6cmV0dXJuIHRoaXMucGFyc2VJZGVudCgpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5icmFja2V0TDp2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dCgpO25vZGUuZWxlbWVudHMgPSB0aGlzLnBhcnNlQmluZGluZ0xpc3QoX3Rva2VudHlwZS50eXBlcy5icmFja2V0Uix0cnVlLHRydWUpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkFycmF5UGF0dGVyblwiKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2VMOnJldHVybiB0aGlzLnBhcnNlT2JqKHRydWUpO2RlZmF1bHQ6dGhpcy51bmV4cGVjdGVkKCk7fX07cHAucGFyc2VCaW5kaW5nTGlzdCA9IGZ1bmN0aW9uKGNsb3NlLGFsbG93RW1wdHksYWxsb3dUcmFpbGluZ0NvbW1hKXt2YXIgZWx0cz1bXSxmaXJzdD10cnVlO3doaWxlKCF0aGlzLmVhdChjbG9zZSkpIHtpZihmaXJzdClmaXJzdCA9IGZhbHNlO2Vsc2UgdGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7aWYoYWxsb3dFbXB0eSAmJiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuY29tbWEpe2VsdHMucHVzaChudWxsKTt9ZWxzZSBpZihhbGxvd1RyYWlsaW5nQ29tbWEgJiYgdGhpcy5hZnRlclRyYWlsaW5nQ29tbWEoY2xvc2UpKXticmVhazt9ZWxzZSBpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpe3ZhciByZXN0PXRoaXMucGFyc2VSZXN0KCk7dGhpcy5wYXJzZUJpbmRpbmdMaXN0SXRlbShyZXN0KTtlbHRzLnB1c2gocmVzdCk7dGhpcy5leHBlY3QoY2xvc2UpO2JyZWFrO31lbHNlIHt2YXIgZWxlbT10aGlzLnBhcnNlTWF5YmVEZWZhdWx0KHRoaXMuc3RhcnQsdGhpcy5zdGFydExvYyk7dGhpcy5wYXJzZUJpbmRpbmdMaXN0SXRlbShlbGVtKTtlbHRzLnB1c2goZWxlbSk7fX1yZXR1cm4gZWx0czt9O3BwLnBhcnNlQmluZGluZ0xpc3RJdGVtID0gZnVuY3Rpb24ocGFyYW0pe3JldHVybiBwYXJhbTt9OyAvLyBQYXJzZXMgYXNzaWdubWVudCBwYXR0ZXJuIGFyb3VuZCBnaXZlbiBhdG9tIGlmIHBvc3NpYmxlLlxucHAucGFyc2VNYXliZURlZmF1bHQgPSBmdW5jdGlvbihzdGFydFBvcyxzdGFydExvYyxsZWZ0KXtsZWZ0ID0gbGVmdCB8fCB0aGlzLnBhcnNlQmluZGluZ0F0b20oKTtpZighdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5lcSkpcmV0dXJuIGxlZnQ7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGVBdChzdGFydFBvcyxzdGFydExvYyk7bm9kZS5sZWZ0ID0gbGVmdDtub2RlLnJpZ2h0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiQXNzaWdubWVudFBhdHRlcm5cIik7fTsgLy8gVmVyaWZ5IHRoYXQgYSBub2RlIGlzIGFuIGx2YWwg4oCUIHNvbWV0aGluZyB0aGF0IGNhbiBiZSBhc3NpZ25lZFxuLy8gdG8uXG5wcC5jaGVja0xWYWwgPSBmdW5jdGlvbihleHByLGlzQmluZGluZyxjaGVja0NsYXNoZXMpe3N3aXRjaChleHByLnR5cGUpe2Nhc2UgXCJJZGVudGlmaWVyXCI6aWYodGhpcy5zdHJpY3QgJiYgKF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0QmluZChleHByLm5hbWUpIHx8IF9pZGVudGlmaWVyLnJlc2VydmVkV29yZHMuc3RyaWN0KGV4cHIubmFtZSkpKXRoaXMucmFpc2UoZXhwci5zdGFydCwoaXNCaW5kaW5nP1wiQmluZGluZyBcIjpcIkFzc2lnbmluZyB0byBcIikgKyBleHByLm5hbWUgKyBcIiBpbiBzdHJpY3QgbW9kZVwiKTtpZihjaGVja0NsYXNoZXMpe2lmKF91dGlsLmhhcyhjaGVja0NsYXNoZXMsZXhwci5uYW1lKSl0aGlzLnJhaXNlKGV4cHIuc3RhcnQsXCJBcmd1bWVudCBuYW1lIGNsYXNoIGluIHN0cmljdCBtb2RlXCIpO2NoZWNrQ2xhc2hlc1tleHByLm5hbWVdID0gdHJ1ZTt9YnJlYWs7Y2FzZSBcIk1lbWJlckV4cHJlc3Npb25cIjppZihpc0JpbmRpbmcpdGhpcy5yYWlzZShleHByLnN0YXJ0LChpc0JpbmRpbmc/XCJCaW5kaW5nXCI6XCJBc3NpZ25pbmcgdG9cIikgKyBcIiBtZW1iZXIgZXhwcmVzc2lvblwiKTticmVhaztjYXNlIFwiT2JqZWN0UGF0dGVyblwiOmZvcih2YXIgaT0wO2kgPCBleHByLnByb3BlcnRpZXMubGVuZ3RoO2krKykge3RoaXMuY2hlY2tMVmFsKGV4cHIucHJvcGVydGllc1tpXS52YWx1ZSxpc0JpbmRpbmcsY2hlY2tDbGFzaGVzKTt9YnJlYWs7Y2FzZSBcIkFycmF5UGF0dGVyblwiOmZvcih2YXIgaT0wO2kgPCBleHByLmVsZW1lbnRzLmxlbmd0aDtpKyspIHt2YXIgZWxlbT1leHByLmVsZW1lbnRzW2ldO2lmKGVsZW0pdGhpcy5jaGVja0xWYWwoZWxlbSxpc0JpbmRpbmcsY2hlY2tDbGFzaGVzKTt9YnJlYWs7Y2FzZSBcIkFzc2lnbm1lbnRQYXR0ZXJuXCI6dGhpcy5jaGVja0xWYWwoZXhwci5sZWZ0LGlzQmluZGluZyxjaGVja0NsYXNoZXMpO2JyZWFrO2Nhc2UgXCJSZXN0RWxlbWVudFwiOnRoaXMuY2hlY2tMVmFsKGV4cHIuYXJndW1lbnQsaXNCaW5kaW5nLGNoZWNrQ2xhc2hlcyk7YnJlYWs7Y2FzZSBcIlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uXCI6dGhpcy5jaGVja0xWYWwoZXhwci5leHByZXNzaW9uLGlzQmluZGluZyxjaGVja0NsYXNoZXMpO2JyZWFrO2RlZmF1bHQ6dGhpcy5yYWlzZShleHByLnN0YXJ0LChpc0JpbmRpbmc/XCJCaW5kaW5nXCI6XCJBc3NpZ25pbmcgdG9cIikgKyBcIiBydmFsdWVcIik7fX07fSx7XCIuL2lkZW50aWZpZXJcIjoyLFwiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vdXRpbFwiOjE1fV0sNzpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtmdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsQ29uc3RydWN0b3Ipe2lmKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3Rvcikpe3Rocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7fX12YXIgX3N0YXRlPV9kZXJlcV8oXCIuL3N0YXRlXCIpO3ZhciBfbG9jdXRpbD1fZGVyZXFfKFwiLi9sb2N1dGlsXCIpO3ZhciBOb2RlPWZ1bmN0aW9uIE5vZGUocGFyc2VyLHBvcyxsb2Mpe19jbGFzc0NhbGxDaGVjayh0aGlzLE5vZGUpO3RoaXMudHlwZSA9IFwiXCI7dGhpcy5zdGFydCA9IHBvczt0aGlzLmVuZCA9IDA7aWYocGFyc2VyLm9wdGlvbnMubG9jYXRpb25zKXRoaXMubG9jID0gbmV3IF9sb2N1dGlsLlNvdXJjZUxvY2F0aW9uKHBhcnNlcixsb2MpO2lmKHBhcnNlci5vcHRpb25zLmRpcmVjdFNvdXJjZUZpbGUpdGhpcy5zb3VyY2VGaWxlID0gcGFyc2VyLm9wdGlvbnMuZGlyZWN0U291cmNlRmlsZTtpZihwYXJzZXIub3B0aW9ucy5yYW5nZXMpdGhpcy5yYW5nZSA9IFtwb3MsMF07fSAvLyBTdGFydCBhbiBBU1Qgbm9kZSwgYXR0YWNoaW5nIGEgc3RhcnQgb2Zmc2V0LlxuO2V4cG9ydHMuTm9kZSA9IE5vZGU7dmFyIHBwPV9zdGF0ZS5QYXJzZXIucHJvdG90eXBlO3BwLnN0YXJ0Tm9kZSA9IGZ1bmN0aW9uKCl7cmV0dXJuIG5ldyBOb2RlKHRoaXMsdGhpcy5zdGFydCx0aGlzLnN0YXJ0TG9jKTt9O3BwLnN0YXJ0Tm9kZUF0ID0gZnVuY3Rpb24ocG9zLGxvYyl7cmV0dXJuIG5ldyBOb2RlKHRoaXMscG9zLGxvYyk7fTsgLy8gRmluaXNoIGFuIEFTVCBub2RlLCBhZGRpbmcgYHR5cGVgIGFuZCBgZW5kYCBwcm9wZXJ0aWVzLlxuZnVuY3Rpb24gZmluaXNoTm9kZUF0KG5vZGUsdHlwZSxwb3MsbG9jKXtub2RlLnR5cGUgPSB0eXBlO25vZGUuZW5kID0gcG9zO2lmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpbm9kZS5sb2MuZW5kID0gbG9jO2lmKHRoaXMub3B0aW9ucy5yYW5nZXMpbm9kZS5yYW5nZVsxXSA9IHBvcztyZXR1cm4gbm9kZTt9cHAuZmluaXNoTm9kZSA9IGZ1bmN0aW9uKG5vZGUsdHlwZSl7cmV0dXJuIGZpbmlzaE5vZGVBdC5jYWxsKHRoaXMsbm9kZSx0eXBlLHRoaXMubGFzdFRva0VuZCx0aGlzLmxhc3RUb2tFbmRMb2MpO307IC8vIEZpbmlzaCBub2RlIGF0IGdpdmVuIHBvc2l0aW9uXG5wcC5maW5pc2hOb2RlQXQgPSBmdW5jdGlvbihub2RlLHR5cGUscG9zLGxvYyl7cmV0dXJuIGZpbmlzaE5vZGVBdC5jYWxsKHRoaXMsbm9kZSx0eXBlLHBvcyxsb2MpO307fSx7XCIuL2xvY3V0aWxcIjo1LFwiLi9zdGF0ZVwiOjEwfV0sODpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtleHBvcnRzLmdldE9wdGlvbnMgPSBnZXRPcHRpb25zO3ZhciBfdXRpbD1fZGVyZXFfKFwiLi91dGlsXCIpO3ZhciBfbG9jdXRpbD1fZGVyZXFfKFwiLi9sb2N1dGlsXCIpOyAvLyBBIHNlY29uZCBvcHRpb25hbCBhcmd1bWVudCBjYW4gYmUgZ2l2ZW4gdG8gZnVydGhlciBjb25maWd1cmVcbi8vIHRoZSBwYXJzZXIgcHJvY2Vzcy4gVGhlc2Ugb3B0aW9ucyBhcmUgcmVjb2duaXplZDpcbnZhciBkZWZhdWx0T3B0aW9ucz17IC8vIGBlY21hVmVyc2lvbmAgaW5kaWNhdGVzIHRoZSBFQ01BU2NyaXB0IHZlcnNpb24gdG8gcGFyc2UuIE11c3Rcbi8vIGJlIGVpdGhlciAzLCBvciA1LCBvciA2LiBUaGlzIGluZmx1ZW5jZXMgc3VwcG9ydCBmb3Igc3RyaWN0XG4vLyBtb2RlLCB0aGUgc2V0IG9mIHJlc2VydmVkIHdvcmRzLCBzdXBwb3J0IGZvciBnZXR0ZXJzIGFuZFxuLy8gc2V0dGVycyBhbmQgb3RoZXIgZmVhdHVyZXMuXG5lY21hVmVyc2lvbjo1LCAvLyBTb3VyY2UgdHlwZSAoXCJzY3JpcHRcIiBvciBcIm1vZHVsZVwiKSBmb3IgZGlmZmVyZW50IHNlbWFudGljc1xuc291cmNlVHlwZTpcInNjcmlwdFwiLCAvLyBgb25JbnNlcnRlZFNlbWljb2xvbmAgY2FuIGJlIGEgY2FsbGJhY2sgdGhhdCB3aWxsIGJlIGNhbGxlZFxuLy8gd2hlbiBhIHNlbWljb2xvbiBpcyBhdXRvbWF0aWNhbGx5IGluc2VydGVkLiBJdCB3aWxsIGJlIHBhc3NlZFxuLy8gdGggcG9zaXRpb24gb2YgdGhlIGNvbW1hIGFzIGFuIG9mZnNldCwgYW5kIGlmIGBsb2NhdGlvbnNgIGlzXG4vLyBlbmFibGVkLCBpdCBpcyBnaXZlbiB0aGUgbG9jYXRpb24gYXMgYSBge2xpbmUsIGNvbHVtbn1gIG9iamVjdFxuLy8gYXMgc2Vjb25kIGFyZ3VtZW50Llxub25JbnNlcnRlZFNlbWljb2xvbjpudWxsLCAvLyBgb25UcmFpbGluZ0NvbW1hYCBpcyBzaW1pbGFyIHRvIGBvbkluc2VydGVkU2VtaWNvbG9uYCwgYnV0IGZvclxuLy8gdHJhaWxpbmcgY29tbWFzLlxub25UcmFpbGluZ0NvbW1hOm51bGwsIC8vIEJ5IGRlZmF1bHQsIHJlc2VydmVkIHdvcmRzIGFyZSBub3QgZW5mb3JjZWQuIERpc2FibGVcbi8vIGBhbGxvd1Jlc2VydmVkYCB0byBlbmZvcmNlIHRoZW0uIFdoZW4gdGhpcyBvcHRpb24gaGFzIHRoZVxuLy8gdmFsdWUgXCJuZXZlclwiLCByZXNlcnZlZCB3b3JkcyBhbmQga2V5d29yZHMgY2FuIGFsc28gbm90IGJlXG4vLyB1c2VkIGFzIHByb3BlcnR5IG5hbWVzLlxuYWxsb3dSZXNlcnZlZDp0cnVlLCAvLyBXaGVuIGVuYWJsZWQsIGEgcmV0dXJuIGF0IHRoZSB0b3AgbGV2ZWwgaXMgbm90IGNvbnNpZGVyZWQgYW5cbi8vIGVycm9yLlxuYWxsb3dSZXR1cm5PdXRzaWRlRnVuY3Rpb246ZmFsc2UsIC8vIFdoZW4gZW5hYmxlZCwgaW1wb3J0L2V4cG9ydCBzdGF0ZW1lbnRzIGFyZSBub3QgY29uc3RyYWluZWQgdG9cbi8vIGFwcGVhcmluZyBhdCB0aGUgdG9wIG9mIHRoZSBwcm9ncmFtLlxuYWxsb3dJbXBvcnRFeHBvcnRFdmVyeXdoZXJlOmZhbHNlLCAvLyBXaGVuIGVuYWJsZWQsIGhhc2hiYW5nIGRpcmVjdGl2ZSBpbiB0aGUgYmVnaW5uaW5nIG9mIGZpbGVcbi8vIGlzIGFsbG93ZWQgYW5kIHRyZWF0ZWQgYXMgYSBsaW5lIGNvbW1lbnQuXG5hbGxvd0hhc2hCYW5nOmZhbHNlLCAvLyBXaGVuIGBsb2NhdGlvbnNgIGlzIG9uLCBgbG9jYCBwcm9wZXJ0aWVzIGhvbGRpbmcgb2JqZWN0cyB3aXRoXG4vLyBgc3RhcnRgIGFuZCBgZW5kYCBwcm9wZXJ0aWVzIGluIGB7bGluZSwgY29sdW1ufWAgZm9ybSAod2l0aFxuLy8gbGluZSBiZWluZyAxLWJhc2VkIGFuZCBjb2x1bW4gMC1iYXNlZCkgd2lsbCBiZSBhdHRhY2hlZCB0byB0aGVcbi8vIG5vZGVzLlxubG9jYXRpb25zOmZhbHNlLCAvLyBBIGZ1bmN0aW9uIGNhbiBiZSBwYXNzZWQgYXMgYG9uVG9rZW5gIG9wdGlvbiwgd2hpY2ggd2lsbFxuLy8gY2F1c2UgQWNvcm4gdG8gY2FsbCB0aGF0IGZ1bmN0aW9uIHdpdGggb2JqZWN0IGluIHRoZSBzYW1lXG4vLyBmb3JtYXQgYXMgdG9rZW5pemUoKSByZXR1cm5zLiBOb3RlIHRoYXQgeW91IGFyZSBub3Rcbi8vIGFsbG93ZWQgdG8gY2FsbCB0aGUgcGFyc2VyIGZyb20gdGhlIGNhbGxiYWNr4oCUdGhhdCB3aWxsXG4vLyBjb3JydXB0IGl0cyBpbnRlcm5hbCBzdGF0ZS5cbm9uVG9rZW46bnVsbCwgLy8gQSBmdW5jdGlvbiBjYW4gYmUgcGFzc2VkIGFzIGBvbkNvbW1lbnRgIG9wdGlvbiwgd2hpY2ggd2lsbFxuLy8gY2F1c2UgQWNvcm4gdG8gY2FsbCB0aGF0IGZ1bmN0aW9uIHdpdGggYChibG9jaywgdGV4dCwgc3RhcnQsXG4vLyBlbmQpYCBwYXJhbWV0ZXJzIHdoZW5ldmVyIGEgY29tbWVudCBpcyBza2lwcGVkLiBgYmxvY2tgIGlzIGFcbi8vIGJvb2xlYW4gaW5kaWNhdGluZyB3aGV0aGVyIHRoaXMgaXMgYSBibG9jayAoYC8qICovYCkgY29tbWVudCxcbi8vIGB0ZXh0YCBpcyB0aGUgY29udGVudCBvZiB0aGUgY29tbWVudCwgYW5kIGBzdGFydGAgYW5kIGBlbmRgIGFyZVxuLy8gY2hhcmFjdGVyIG9mZnNldHMgdGhhdCBkZW5vdGUgdGhlIHN0YXJ0IGFuZCBlbmQgb2YgdGhlIGNvbW1lbnQuXG4vLyBXaGVuIHRoZSBgbG9jYXRpb25zYCBvcHRpb24gaXMgb24sIHR3byBtb3JlIHBhcmFtZXRlcnMgYXJlXG4vLyBwYXNzZWQsIHRoZSBmdWxsIGB7bGluZSwgY29sdW1ufWAgbG9jYXRpb25zIG9mIHRoZSBzdGFydCBhbmRcbi8vIGVuZCBvZiB0aGUgY29tbWVudHMuIE5vdGUgdGhhdCB5b3UgYXJlIG5vdCBhbGxvd2VkIHRvIGNhbGwgdGhlXG4vLyBwYXJzZXIgZnJvbSB0aGUgY2FsbGJhY2vigJR0aGF0IHdpbGwgY29ycnVwdCBpdHMgaW50ZXJuYWwgc3RhdGUuXG5vbkNvbW1lbnQ6bnVsbCwgLy8gTm9kZXMgaGF2ZSB0aGVpciBzdGFydCBhbmQgZW5kIGNoYXJhY3RlcnMgb2Zmc2V0cyByZWNvcmRlZCBpblxuLy8gYHN0YXJ0YCBhbmQgYGVuZGAgcHJvcGVydGllcyAoZGlyZWN0bHkgb24gdGhlIG5vZGUsIHJhdGhlciB0aGFuXG4vLyB0aGUgYGxvY2Agb2JqZWN0LCB3aGljaCBob2xkcyBsaW5lL2NvbHVtbiBkYXRhLiBUbyBhbHNvIGFkZCBhXG4vLyBbc2VtaS1zdGFuZGFyZGl6ZWRdW3JhbmdlXSBgcmFuZ2VgIHByb3BlcnR5IGhvbGRpbmcgYSBgW3N0YXJ0LFxuLy8gZW5kXWAgYXJyYXkgd2l0aCB0aGUgc2FtZSBudW1iZXJzLCBzZXQgdGhlIGByYW5nZXNgIG9wdGlvbiB0b1xuLy8gYHRydWVgLlxuLy9cbi8vIFtyYW5nZV06IGh0dHBzOi8vYnVnemlsbGEubW96aWxsYS5vcmcvc2hvd19idWcuY2dpP2lkPTc0NTY3OFxucmFuZ2VzOmZhbHNlLCAvLyBJdCBpcyBwb3NzaWJsZSB0byBwYXJzZSBtdWx0aXBsZSBmaWxlcyBpbnRvIGEgc2luZ2xlIEFTVCBieVxuLy8gcGFzc2luZyB0aGUgdHJlZSBwcm9kdWNlZCBieSBwYXJzaW5nIHRoZSBmaXJzdCBmaWxlIGFzXG4vLyBgcHJvZ3JhbWAgb3B0aW9uIGluIHN1YnNlcXVlbnQgcGFyc2VzLiBUaGlzIHdpbGwgYWRkIHRoZVxuLy8gdG9wbGV2ZWwgZm9ybXMgb2YgdGhlIHBhcnNlZCBmaWxlIHRvIHRoZSBgUHJvZ3JhbWAgKHRvcCkgbm9kZVxuLy8gb2YgYW4gZXhpc3RpbmcgcGFyc2UgdHJlZS5cbnByb2dyYW06bnVsbCwgLy8gV2hlbiBgbG9jYXRpb25zYCBpcyBvbiwgeW91IGNhbiBwYXNzIHRoaXMgdG8gcmVjb3JkIHRoZSBzb3VyY2Vcbi8vIGZpbGUgaW4gZXZlcnkgbm9kZSdzIGBsb2NgIG9iamVjdC5cbnNvdXJjZUZpbGU6bnVsbCwgLy8gVGhpcyB2YWx1ZSwgaWYgZ2l2ZW4sIGlzIHN0b3JlZCBpbiBldmVyeSBub2RlLCB3aGV0aGVyXG4vLyBgbG9jYXRpb25zYCBpcyBvbiBvciBvZmYuXG5kaXJlY3RTb3VyY2VGaWxlOm51bGwsIC8vIFdoZW4gZW5hYmxlZCwgcGFyZW50aGVzaXplZCBleHByZXNzaW9ucyBhcmUgcmVwcmVzZW50ZWQgYnlcbi8vIChub24tc3RhbmRhcmQpIFBhcmVudGhlc2l6ZWRFeHByZXNzaW9uIG5vZGVzXG5wcmVzZXJ2ZVBhcmVuczpmYWxzZSxwbHVnaW5zOnt9fTtleHBvcnRzLmRlZmF1bHRPcHRpb25zID0gZGVmYXVsdE9wdGlvbnM7IC8vIEludGVycHJldCBhbmQgZGVmYXVsdCBhbiBvcHRpb25zIG9iamVjdFxuZnVuY3Rpb24gZ2V0T3B0aW9ucyhvcHRzKXt2YXIgb3B0aW9ucz17fTtmb3IodmFyIG9wdCBpbiBkZWZhdWx0T3B0aW9ucykge29wdGlvbnNbb3B0XSA9IG9wdHMgJiYgX3V0aWwuaGFzKG9wdHMsb3B0KT9vcHRzW29wdF06ZGVmYXVsdE9wdGlvbnNbb3B0XTt9aWYoX3V0aWwuaXNBcnJheShvcHRpb25zLm9uVG9rZW4pKXsoZnVuY3Rpb24oKXt2YXIgdG9rZW5zPW9wdGlvbnMub25Ub2tlbjtvcHRpb25zLm9uVG9rZW4gPSBmdW5jdGlvbih0b2tlbil7cmV0dXJuIHRva2Vucy5wdXNoKHRva2VuKTt9O30pKCk7fWlmKF91dGlsLmlzQXJyYXkob3B0aW9ucy5vbkNvbW1lbnQpKW9wdGlvbnMub25Db21tZW50ID0gcHVzaENvbW1lbnQob3B0aW9ucyxvcHRpb25zLm9uQ29tbWVudCk7cmV0dXJuIG9wdGlvbnM7fWZ1bmN0aW9uIHB1c2hDb21tZW50KG9wdGlvbnMsYXJyYXkpe3JldHVybiBmdW5jdGlvbihibG9jayx0ZXh0LHN0YXJ0LGVuZCxzdGFydExvYyxlbmRMb2Mpe3ZhciBjb21tZW50PXt0eXBlOmJsb2NrPydCbG9jayc6J0xpbmUnLHZhbHVlOnRleHQsc3RhcnQ6c3RhcnQsZW5kOmVuZH07aWYob3B0aW9ucy5sb2NhdGlvbnMpY29tbWVudC5sb2MgPSBuZXcgX2xvY3V0aWwuU291cmNlTG9jYXRpb24odGhpcyxzdGFydExvYyxlbmRMb2MpO2lmKG9wdGlvbnMucmFuZ2VzKWNvbW1lbnQucmFuZ2UgPSBbc3RhcnQsZW5kXTthcnJheS5wdXNoKGNvbW1lbnQpO307fX0se1wiLi9sb2N1dGlsXCI6NSxcIi4vdXRpbFwiOjE1fV0sOTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7dmFyIF90b2tlbnR5cGU9X2RlcmVxXyhcIi4vdG9rZW50eXBlXCIpO3ZhciBfc3RhdGU9X2RlcmVxXyhcIi4vc3RhdGVcIik7dmFyIF93aGl0ZXNwYWNlPV9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7dmFyIHBwPV9zdGF0ZS5QYXJzZXIucHJvdG90eXBlOyAvLyAjIyBQYXJzZXIgdXRpbGl0aWVzXG4vLyBUZXN0IHdoZXRoZXIgYSBzdGF0ZW1lbnQgbm9kZSBpcyB0aGUgc3RyaW5nIGxpdGVyYWwgYFwidXNlIHN0cmljdFwiYC5cbnBwLmlzVXNlU3RyaWN0ID0gZnVuY3Rpb24oc3RtdCl7cmV0dXJuIHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA1ICYmIHN0bXQudHlwZSA9PT0gXCJFeHByZXNzaW9uU3RhdGVtZW50XCIgJiYgc3RtdC5leHByZXNzaW9uLnR5cGUgPT09IFwiTGl0ZXJhbFwiICYmIHN0bXQuZXhwcmVzc2lvbi5yYXcuc2xpY2UoMSwtMSkgPT09IFwidXNlIHN0cmljdFwiO307IC8vIFByZWRpY2F0ZSB0aGF0IHRlc3RzIHdoZXRoZXIgdGhlIG5leHQgdG9rZW4gaXMgb2YgdGhlIGdpdmVuXG4vLyB0eXBlLCBhbmQgaWYgeWVzLCBjb25zdW1lcyBpdCBhcyBhIHNpZGUgZWZmZWN0LlxucHAuZWF0ID0gZnVuY3Rpb24odHlwZSl7aWYodGhpcy50eXBlID09PSB0eXBlKXt0aGlzLm5leHQoKTtyZXR1cm4gdHJ1ZTt9ZWxzZSB7cmV0dXJuIGZhbHNlO319OyAvLyBUZXN0cyB3aGV0aGVyIHBhcnNlZCB0b2tlbiBpcyBhIGNvbnRleHR1YWwga2V5d29yZC5cbnBwLmlzQ29udGV4dHVhbCA9IGZ1bmN0aW9uKG5hbWUpe3JldHVybiB0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMubmFtZSAmJiB0aGlzLnZhbHVlID09PSBuYW1lO307IC8vIENvbnN1bWVzIGNvbnRleHR1YWwga2V5d29yZCBpZiBwb3NzaWJsZS5cbnBwLmVhdENvbnRleHR1YWwgPSBmdW5jdGlvbihuYW1lKXtyZXR1cm4gdGhpcy52YWx1ZSA9PT0gbmFtZSAmJiB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLm5hbWUpO307IC8vIEFzc2VydHMgdGhhdCBmb2xsb3dpbmcgdG9rZW4gaXMgZ2l2ZW4gY29udGV4dHVhbCBrZXl3b3JkLlxucHAuZXhwZWN0Q29udGV4dHVhbCA9IGZ1bmN0aW9uKG5hbWUpe2lmKCF0aGlzLmVhdENvbnRleHR1YWwobmFtZSkpdGhpcy51bmV4cGVjdGVkKCk7fTsgLy8gVGVzdCB3aGV0aGVyIGEgc2VtaWNvbG9uIGNhbiBiZSBpbnNlcnRlZCBhdCB0aGUgY3VycmVudCBwb3NpdGlvbi5cbnBwLmNhbkluc2VydFNlbWljb2xvbiA9IGZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5lb2YgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmJyYWNlUiB8fCBfd2hpdGVzcGFjZS5saW5lQnJlYWsudGVzdCh0aGlzLmlucHV0LnNsaWNlKHRoaXMubGFzdFRva0VuZCx0aGlzLnN0YXJ0KSk7fTtwcC5pbnNlcnRTZW1pY29sb24gPSBmdW5jdGlvbigpe2lmKHRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkpe2lmKHRoaXMub3B0aW9ucy5vbkluc2VydGVkU2VtaWNvbG9uKXRoaXMub3B0aW9ucy5vbkluc2VydGVkU2VtaWNvbG9uKHRoaXMubGFzdFRva0VuZCx0aGlzLmxhc3RUb2tFbmRMb2MpO3JldHVybiB0cnVlO319OyAvLyBDb25zdW1lIGEgc2VtaWNvbG9uLCBvciwgZmFpbGluZyB0aGF0LCBzZWUgaWYgd2UgYXJlIGFsbG93ZWQgdG9cbi8vIHByZXRlbmQgdGhhdCB0aGVyZSBpcyBhIHNlbWljb2xvbiBhdCB0aGlzIHBvc2l0aW9uLlxucHAuc2VtaWNvbG9uID0gZnVuY3Rpb24oKXtpZighdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zZW1pKSAmJiAhdGhpcy5pbnNlcnRTZW1pY29sb24oKSl0aGlzLnVuZXhwZWN0ZWQoKTt9O3BwLmFmdGVyVHJhaWxpbmdDb21tYSA9IGZ1bmN0aW9uKHRva1R5cGUpe2lmKHRoaXMudHlwZSA9PSB0b2tUeXBlKXtpZih0aGlzLm9wdGlvbnMub25UcmFpbGluZ0NvbW1hKXRoaXMub3B0aW9ucy5vblRyYWlsaW5nQ29tbWEodGhpcy5sYXN0VG9rU3RhcnQsdGhpcy5sYXN0VG9rU3RhcnRMb2MpO3RoaXMubmV4dCgpO3JldHVybiB0cnVlO319OyAvLyBFeHBlY3QgYSB0b2tlbiBvZiBhIGdpdmVuIHR5cGUuIElmIGZvdW5kLCBjb25zdW1lIGl0LCBvdGhlcndpc2UsXG4vLyByYWlzZSBhbiB1bmV4cGVjdGVkIHRva2VuIGVycm9yLlxucHAuZXhwZWN0ID0gZnVuY3Rpb24odHlwZSl7dGhpcy5lYXQodHlwZSkgfHwgdGhpcy51bmV4cGVjdGVkKCk7fTsgLy8gUmFpc2UgYW4gdW5leHBlY3RlZCB0b2tlbiBlcnJvci5cbnBwLnVuZXhwZWN0ZWQgPSBmdW5jdGlvbihwb3Mpe3RoaXMucmFpc2UocG9zICE9IG51bGw/cG9zOnRoaXMuc3RhcnQsXCJVbmV4cGVjdGVkIHRva2VuXCIpO307fSx7XCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSwxMDpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtmdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsQ29uc3RydWN0b3Ipe2lmKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3Rvcikpe3Rocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7fX12YXIgX2lkZW50aWZpZXI9X2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTt2YXIgX3Rva2VudHlwZT1fZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7dmFyIF93aGl0ZXNwYWNlPV9kZXJlcV8oXCIuL3doaXRlc3BhY2VcIik7dmFyIF9vcHRpb25zPV9kZXJlcV8oXCIuL29wdGlvbnNcIik7IC8vIFJlZ2lzdGVyZWQgcGx1Z2luc1xudmFyIHBsdWdpbnM9e307ZXhwb3J0cy5wbHVnaW5zID0gcGx1Z2luczt2YXIgUGFyc2VyPShmdW5jdGlvbigpe2Z1bmN0aW9uIFBhcnNlcihvcHRpb25zLGlucHV0LHN0YXJ0UG9zKXtfY2xhc3NDYWxsQ2hlY2sodGhpcyxQYXJzZXIpO3RoaXMub3B0aW9ucyA9IF9vcHRpb25zLmdldE9wdGlvbnMob3B0aW9ucyk7dGhpcy5zb3VyY2VGaWxlID0gdGhpcy5vcHRpb25zLnNvdXJjZUZpbGU7dGhpcy5pc0tleXdvcmQgPSBfaWRlbnRpZmllci5rZXl3b3Jkc1t0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNj82OjVdO3RoaXMuaXNSZXNlcnZlZFdvcmQgPSBfaWRlbnRpZmllci5yZXNlcnZlZFdvcmRzW3RoaXMub3B0aW9ucy5lY21hVmVyc2lvbl07dGhpcy5pbnB1dCA9IFN0cmluZyhpbnB1dCk7IC8vIFVzZWQgdG8gc2lnbmFsIHRvIGNhbGxlcnMgb2YgYHJlYWRXb3JkMWAgd2hldGhlciB0aGUgd29yZFxuLy8gY29udGFpbmVkIGFueSBlc2NhcGUgc2VxdWVuY2VzLiBUaGlzIGlzIG5lZWRlZCBiZWNhdXNlIHdvcmRzIHdpdGhcbi8vIGVzY2FwZSBzZXF1ZW5jZXMgbXVzdCBub3QgYmUgaW50ZXJwcmV0ZWQgYXMga2V5d29yZHMuXG50aGlzLmNvbnRhaW5zRXNjID0gZmFsc2U7IC8vIExvYWQgcGx1Z2luc1xudGhpcy5sb2FkUGx1Z2lucyh0aGlzLm9wdGlvbnMucGx1Z2lucyk7IC8vIFNldCB1cCB0b2tlbiBzdGF0ZVxuLy8gVGhlIGN1cnJlbnQgcG9zaXRpb24gb2YgdGhlIHRva2VuaXplciBpbiB0aGUgaW5wdXQuXG5pZihzdGFydFBvcyl7dGhpcy5wb3MgPSBzdGFydFBvczt0aGlzLmxpbmVTdGFydCA9IE1hdGgubWF4KDAsdGhpcy5pbnB1dC5sYXN0SW5kZXhPZihcIlxcblwiLHN0YXJ0UG9zKSk7dGhpcy5jdXJMaW5lID0gdGhpcy5pbnB1dC5zbGljZSgwLHRoaXMubGluZVN0YXJ0KS5zcGxpdChfd2hpdGVzcGFjZS5saW5lQnJlYWspLmxlbmd0aDt9ZWxzZSB7dGhpcy5wb3MgPSB0aGlzLmxpbmVTdGFydCA9IDA7dGhpcy5jdXJMaW5lID0gMTt9IC8vIFByb3BlcnRpZXMgb2YgdGhlIGN1cnJlbnQgdG9rZW46XG4vLyBJdHMgdHlwZVxudGhpcy50eXBlID0gX3Rva2VudHlwZS50eXBlcy5lb2Y7IC8vIEZvciB0b2tlbnMgdGhhdCBpbmNsdWRlIG1vcmUgaW5mb3JtYXRpb24gdGhhbiB0aGVpciB0eXBlLCB0aGUgdmFsdWVcbnRoaXMudmFsdWUgPSBudWxsOyAvLyBJdHMgc3RhcnQgYW5kIGVuZCBvZmZzZXRcbnRoaXMuc3RhcnQgPSB0aGlzLmVuZCA9IHRoaXMucG9zOyAvLyBBbmQsIGlmIGxvY2F0aW9ucyBhcmUgdXNlZCwgdGhlIHtsaW5lLCBjb2x1bW59IG9iamVjdFxuLy8gY29ycmVzcG9uZGluZyB0byB0aG9zZSBvZmZzZXRzXG50aGlzLnN0YXJ0TG9jID0gdGhpcy5lbmRMb2MgPSB0aGlzLmN1clBvc2l0aW9uKCk7IC8vIFBvc2l0aW9uIGluZm9ybWF0aW9uIGZvciB0aGUgcHJldmlvdXMgdG9rZW5cbnRoaXMubGFzdFRva0VuZExvYyA9IHRoaXMubGFzdFRva1N0YXJ0TG9jID0gbnVsbDt0aGlzLmxhc3RUb2tTdGFydCA9IHRoaXMubGFzdFRva0VuZCA9IHRoaXMucG9zOyAvLyBUaGUgY29udGV4dCBzdGFjayBpcyB1c2VkIHRvIHN1cGVyZmljaWFsbHkgdHJhY2sgc3ludGFjdGljXG4vLyBjb250ZXh0IHRvIHByZWRpY3Qgd2hldGhlciBhIHJlZ3VsYXIgZXhwcmVzc2lvbiBpcyBhbGxvd2VkIGluIGFcbi8vIGdpdmVuIHBvc2l0aW9uLlxudGhpcy5jb250ZXh0ID0gdGhpcy5pbml0aWFsQ29udGV4dCgpO3RoaXMuZXhwckFsbG93ZWQgPSB0cnVlOyAvLyBGaWd1cmUgb3V0IGlmIGl0J3MgYSBtb2R1bGUgY29kZS5cbnRoaXMuc3RyaWN0ID0gdGhpcy5pbk1vZHVsZSA9IHRoaXMub3B0aW9ucy5zb3VyY2VUeXBlID09PSBcIm1vZHVsZVwiOyAvLyBVc2VkIHRvIHNpZ25pZnkgdGhlIHN0YXJ0IG9mIGEgcG90ZW50aWFsIGFycm93IGZ1bmN0aW9uXG50aGlzLnBvdGVudGlhbEFycm93QXQgPSAtMTsgLy8gRmxhZ3MgdG8gdHJhY2sgd2hldGhlciB3ZSBhcmUgaW4gYSBmdW5jdGlvbiwgYSBnZW5lcmF0b3IuXG50aGlzLmluRnVuY3Rpb24gPSB0aGlzLmluR2VuZXJhdG9yID0gZmFsc2U7IC8vIExhYmVscyBpbiBzY29wZS5cbnRoaXMubGFiZWxzID0gW107IC8vIElmIGVuYWJsZWQsIHNraXAgbGVhZGluZyBoYXNoYmFuZyBsaW5lLlxuaWYodGhpcy5wb3MgPT09IDAgJiYgdGhpcy5vcHRpb25zLmFsbG93SGFzaEJhbmcgJiYgdGhpcy5pbnB1dC5zbGljZSgwLDIpID09PSAnIyEnKXRoaXMuc2tpcExpbmVDb21tZW50KDIpO31QYXJzZXIucHJvdG90eXBlLmV4dGVuZCA9IGZ1bmN0aW9uIGV4dGVuZChuYW1lLGYpe3RoaXNbbmFtZV0gPSBmKHRoaXNbbmFtZV0pO307UGFyc2VyLnByb3RvdHlwZS5sb2FkUGx1Z2lucyA9IGZ1bmN0aW9uIGxvYWRQbHVnaW5zKHBsdWdpbkNvbmZpZ3Mpe2Zvcih2YXIgX25hbWUgaW4gcGx1Z2luQ29uZmlncykge3ZhciBwbHVnaW49cGx1Z2luc1tfbmFtZV07aWYoIXBsdWdpbil0aHJvdyBuZXcgRXJyb3IoXCJQbHVnaW4gJ1wiICsgX25hbWUgKyBcIicgbm90IGZvdW5kXCIpO3BsdWdpbih0aGlzLHBsdWdpbkNvbmZpZ3NbX25hbWVdKTt9fTtQYXJzZXIucHJvdG90eXBlLnBhcnNlID0gZnVuY3Rpb24gcGFyc2UoKXt2YXIgbm9kZT10aGlzLm9wdGlvbnMucHJvZ3JhbSB8fCB0aGlzLnN0YXJ0Tm9kZSgpO3RoaXMubmV4dFRva2VuKCk7cmV0dXJuIHRoaXMucGFyc2VUb3BMZXZlbChub2RlKTt9O3JldHVybiBQYXJzZXI7fSkoKTtleHBvcnRzLlBhcnNlciA9IFBhcnNlcjt9LHtcIi4vaWRlbnRpZmllclwiOjIsXCIuL29wdGlvbnNcIjo4LFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTE6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1widXNlIHN0cmljdFwiO3ZhciBfdG9rZW50eXBlPV9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTt2YXIgX3N0YXRlPV9kZXJlcV8oXCIuL3N0YXRlXCIpO3ZhciBfd2hpdGVzcGFjZT1fZGVyZXFfKFwiLi93aGl0ZXNwYWNlXCIpO3ZhciBwcD1fc3RhdGUuUGFyc2VyLnByb3RvdHlwZTsgLy8gIyMjIFN0YXRlbWVudCBwYXJzaW5nXG4vLyBQYXJzZSBhIHByb2dyYW0uIEluaXRpYWxpemVzIHRoZSBwYXJzZXIsIHJlYWRzIGFueSBudW1iZXIgb2Zcbi8vIHN0YXRlbWVudHMsIGFuZCB3cmFwcyB0aGVtIGluIGEgUHJvZ3JhbSBub2RlLiAgT3B0aW9uYWxseSB0YWtlcyBhXG4vLyBgcHJvZ3JhbWAgYXJndW1lbnQuICBJZiBwcmVzZW50LCB0aGUgc3RhdGVtZW50cyB3aWxsIGJlIGFwcGVuZGVkXG4vLyB0byBpdHMgYm9keSBpbnN0ZWFkIG9mIGNyZWF0aW5nIGEgbmV3IG5vZGUuXG5wcC5wYXJzZVRvcExldmVsID0gZnVuY3Rpb24obm9kZSl7dmFyIGZpcnN0PXRydWU7aWYoIW5vZGUuYm9keSlub2RlLmJvZHkgPSBbXTt3aGlsZSh0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMuZW9mKSB7dmFyIHN0bXQ9dGhpcy5wYXJzZVN0YXRlbWVudCh0cnVlLHRydWUpO25vZGUuYm9keS5wdXNoKHN0bXQpO2lmKGZpcnN0KXtpZih0aGlzLmlzVXNlU3RyaWN0KHN0bXQpKXRoaXMuc2V0U3RyaWN0KHRydWUpO2ZpcnN0ID0gZmFsc2U7fX10aGlzLm5leHQoKTtpZih0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil7bm9kZS5zb3VyY2VUeXBlID0gdGhpcy5vcHRpb25zLnNvdXJjZVR5cGU7fXJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIlByb2dyYW1cIik7fTt2YXIgbG9vcExhYmVsPXtraW5kOlwibG9vcFwifSxzd2l0Y2hMYWJlbD17a2luZDpcInN3aXRjaFwifTsgLy8gUGFyc2UgYSBzaW5nbGUgc3RhdGVtZW50LlxuLy9cbi8vIElmIGV4cGVjdGluZyBhIHN0YXRlbWVudCBhbmQgZmluZGluZyBhIHNsYXNoIG9wZXJhdG9yLCBwYXJzZSBhXG4vLyByZWd1bGFyIGV4cHJlc3Npb24gbGl0ZXJhbC4gVGhpcyBpcyB0byBoYW5kbGUgY2FzZXMgbGlrZVxuLy8gYGlmIChmb28pIC9ibGFoLy5leGVjKGZvbylgLCB3aGVyZSBsb29raW5nIGF0IHRoZSBwcmV2aW91cyB0b2tlblxuLy8gZG9lcyBub3QgaGVscC5cbnBwLnBhcnNlU3RhdGVtZW50ID0gZnVuY3Rpb24oZGVjbGFyYXRpb24sdG9wTGV2ZWwpe3ZhciBzdGFydHR5cGU9dGhpcy50eXBlLG5vZGU9dGhpcy5zdGFydE5vZGUoKTsgLy8gTW9zdCB0eXBlcyBvZiBzdGF0ZW1lbnRzIGFyZSByZWNvZ25pemVkIGJ5IHRoZSBrZXl3b3JkIHRoZXlcbi8vIHN0YXJ0IHdpdGguIE1hbnkgYXJlIHRyaXZpYWwgdG8gcGFyc2UsIHNvbWUgcmVxdWlyZSBhIGJpdCBvZlxuLy8gY29tcGxleGl0eS5cbnN3aXRjaChzdGFydHR5cGUpe2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fYnJlYWs6Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9jb250aW51ZTpyZXR1cm4gdGhpcy5wYXJzZUJyZWFrQ29udGludWVTdGF0ZW1lbnQobm9kZSxzdGFydHR5cGUua2V5d29yZCk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9kZWJ1Z2dlcjpyZXR1cm4gdGhpcy5wYXJzZURlYnVnZ2VyU3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fZG86cmV0dXJuIHRoaXMucGFyc2VEb1N0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2ZvcjpyZXR1cm4gdGhpcy5wYXJzZUZvclN0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2Z1bmN0aW9uOmlmKCFkZWNsYXJhdGlvbiAmJiB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNil0aGlzLnVuZXhwZWN0ZWQoKTtyZXR1cm4gdGhpcy5wYXJzZUZ1bmN0aW9uU3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fY2xhc3M6aWYoIWRlY2xhcmF0aW9uKXRoaXMudW5leHBlY3RlZCgpO3JldHVybiB0aGlzLnBhcnNlQ2xhc3Mobm9kZSx0cnVlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX2lmOnJldHVybiB0aGlzLnBhcnNlSWZTdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9yZXR1cm46cmV0dXJuIHRoaXMucGFyc2VSZXR1cm5TdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl9zd2l0Y2g6cmV0dXJuIHRoaXMucGFyc2VTd2l0Y2hTdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl90aHJvdzpyZXR1cm4gdGhpcy5wYXJzZVRocm93U3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fdHJ5OnJldHVybiB0aGlzLnBhcnNlVHJ5U3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fbGV0OmNhc2UgX3Rva2VudHlwZS50eXBlcy5fY29uc3Q6aWYoIWRlY2xhcmF0aW9uKXRoaXMudW5leHBlY3RlZCgpOyAvLyBOT1RFOiBmYWxscyB0aHJvdWdoIHRvIF92YXJcbmNhc2UgX3Rva2VudHlwZS50eXBlcy5fdmFyOnJldHVybiB0aGlzLnBhcnNlVmFyU3RhdGVtZW50KG5vZGUsc3RhcnR0eXBlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuX3doaWxlOnJldHVybiB0aGlzLnBhcnNlV2hpbGVTdGF0ZW1lbnQobm9kZSk7Y2FzZSBfdG9rZW50eXBlLnR5cGVzLl93aXRoOnJldHVybiB0aGlzLnBhcnNlV2l0aFN0YXRlbWVudChub2RlKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuYnJhY2VMOnJldHVybiB0aGlzLnBhcnNlQmxvY2soKTtjYXNlIF90b2tlbnR5cGUudHlwZXMuc2VtaTpyZXR1cm4gdGhpcy5wYXJzZUVtcHR5U3RhdGVtZW50KG5vZGUpO2Nhc2UgX3Rva2VudHlwZS50eXBlcy5fZXhwb3J0OmNhc2UgX3Rva2VudHlwZS50eXBlcy5faW1wb3J0OmlmKCF0aGlzLm9wdGlvbnMuYWxsb3dJbXBvcnRFeHBvcnRFdmVyeXdoZXJlKXtpZighdG9wTGV2ZWwpdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LFwiJ2ltcG9ydCcgYW5kICdleHBvcnQnIG1heSBvbmx5IGFwcGVhciBhdCB0aGUgdG9wIGxldmVsXCIpO2lmKCF0aGlzLmluTW9kdWxlKXRoaXMucmFpc2UodGhpcy5zdGFydCxcIidpbXBvcnQnIGFuZCAnZXhwb3J0JyBtYXkgYXBwZWFyIG9ubHkgd2l0aCAnc291cmNlVHlwZTogbW9kdWxlJ1wiKTt9cmV0dXJuIHN0YXJ0dHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW1wb3J0P3RoaXMucGFyc2VJbXBvcnQobm9kZSk6dGhpcy5wYXJzZUV4cG9ydChub2RlKTsgLy8gSWYgdGhlIHN0YXRlbWVudCBkb2VzIG5vdCBzdGFydCB3aXRoIGEgc3RhdGVtZW50IGtleXdvcmQgb3IgYVxuLy8gYnJhY2UsIGl0J3MgYW4gRXhwcmVzc2lvblN0YXRlbWVudCBvciBMYWJlbGVkU3RhdGVtZW50LiBXZVxuLy8gc2ltcGx5IHN0YXJ0IHBhcnNpbmcgYW4gZXhwcmVzc2lvbiwgYW5kIGFmdGVyd2FyZHMsIGlmIHRoZVxuLy8gbmV4dCB0b2tlbiBpcyBhIGNvbG9uIGFuZCB0aGUgZXhwcmVzc2lvbiB3YXMgYSBzaW1wbGVcbi8vIElkZW50aWZpZXIgbm9kZSwgd2Ugc3dpdGNoIHRvIGludGVycHJldGluZyBpdCBhcyBhIGxhYmVsLlxuZGVmYXVsdDp2YXIgbWF5YmVOYW1lPXRoaXMudmFsdWUsZXhwcj10aGlzLnBhcnNlRXhwcmVzc2lvbigpO2lmKHN0YXJ0dHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lICYmIGV4cHIudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb2xvbikpcmV0dXJuIHRoaXMucGFyc2VMYWJlbGVkU3RhdGVtZW50KG5vZGUsbWF5YmVOYW1lLGV4cHIpO2Vsc2UgcmV0dXJuIHRoaXMucGFyc2VFeHByZXNzaW9uU3RhdGVtZW50KG5vZGUsZXhwcik7fX07cHAucGFyc2VCcmVha0NvbnRpbnVlU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSxrZXl3b3JkKXt2YXIgaXNCcmVhaz1rZXl3b3JkID09IFwiYnJlYWtcIjt0aGlzLm5leHQoKTtpZih0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpIHx8IHRoaXMuaW5zZXJ0U2VtaWNvbG9uKCkpbm9kZS5sYWJlbCA9IG51bGw7ZWxzZSBpZih0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMubmFtZSl0aGlzLnVuZXhwZWN0ZWQoKTtlbHNlIHtub2RlLmxhYmVsID0gdGhpcy5wYXJzZUlkZW50KCk7dGhpcy5zZW1pY29sb24oKTt9IC8vIFZlcmlmeSB0aGF0IHRoZXJlIGlzIGFuIGFjdHVhbCBkZXN0aW5hdGlvbiB0byBicmVhayBvclxuLy8gY29udGludWUgdG8uXG5mb3IodmFyIGk9MDtpIDwgdGhpcy5sYWJlbHMubGVuZ3RoOysraSkge3ZhciBsYWI9dGhpcy5sYWJlbHNbaV07aWYobm9kZS5sYWJlbCA9PSBudWxsIHx8IGxhYi5uYW1lID09PSBub2RlLmxhYmVsLm5hbWUpe2lmKGxhYi5raW5kICE9IG51bGwgJiYgKGlzQnJlYWsgfHwgbGFiLmtpbmQgPT09IFwibG9vcFwiKSlicmVhaztpZihub2RlLmxhYmVsICYmIGlzQnJlYWspYnJlYWs7fX1pZihpID09PSB0aGlzLmxhYmVscy5sZW5ndGgpdGhpcy5yYWlzZShub2RlLnN0YXJ0LFwiVW5zeW50YWN0aWMgXCIgKyBrZXl3b3JkKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsaXNCcmVhaz9cIkJyZWFrU3RhdGVtZW50XCI6XCJDb250aW51ZVN0YXRlbWVudFwiKTt9O3BwLnBhcnNlRGVidWdnZXJTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTt0aGlzLnNlbWljb2xvbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkRlYnVnZ2VyU3RhdGVtZW50XCIpO307cHAucGFyc2VEb1N0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUpe3RoaXMubmV4dCgpO3RoaXMubGFiZWxzLnB1c2gobG9vcExhYmVsKTtub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTt0aGlzLmxhYmVscy5wb3AoKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLl93aGlsZSk7bm9kZS50ZXN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSk7ZWxzZSB0aGlzLnNlbWljb2xvbigpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkRvV2hpbGVTdGF0ZW1lbnRcIik7fTsgLy8gRGlzYW1iaWd1YXRpbmcgYmV0d2VlbiBhIGBmb3JgIGFuZCBhIGBmb3JgL2BpbmAgb3IgYGZvcmAvYG9mYFxuLy8gbG9vcCBpcyBub24tdHJpdmlhbC4gQmFzaWNhbGx5LCB3ZSBoYXZlIHRvIHBhcnNlIHRoZSBpbml0IGB2YXJgXG4vLyBzdGF0ZW1lbnQgb3IgZXhwcmVzc2lvbiwgZGlzYWxsb3dpbmcgdGhlIGBpbmAgb3BlcmF0b3IgKHNlZVxuLy8gdGhlIHNlY29uZCBwYXJhbWV0ZXIgdG8gYHBhcnNlRXhwcmVzc2lvbmApLCBhbmQgdGhlbiBjaGVja1xuLy8gd2hldGhlciB0aGUgbmV4dCB0b2tlbiBpcyBgaW5gIG9yIGBvZmAuIFdoZW4gdGhlcmUgaXMgbm8gaW5pdFxuLy8gcGFydCAoc2VtaWNvbG9uIGltbWVkaWF0ZWx5IGFmdGVyIHRoZSBvcGVuaW5nIHBhcmVudGhlc2lzKSwgaXRcbi8vIGlzIGEgcmVndWxhciBgZm9yYCBsb29wLlxucHAucGFyc2VGb3JTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTt0aGlzLmxhYmVscy5wdXNoKGxvb3BMYWJlbCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO2lmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zZW1pKXJldHVybiB0aGlzLnBhcnNlRm9yKG5vZGUsbnVsbCk7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl92YXIgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9sZXQgfHwgdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9jb25zdCl7dmFyIF9pbml0PXRoaXMuc3RhcnROb2RlKCksdmFyS2luZD10aGlzLnR5cGU7dGhpcy5uZXh0KCk7dGhpcy5wYXJzZVZhcihfaW5pdCx0cnVlLHZhcktpbmQpO3RoaXMuZmluaXNoTm9kZShfaW5pdCxcIlZhcmlhYmxlRGVjbGFyYXRpb25cIik7aWYoKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkgJiYgX2luaXQuZGVjbGFyYXRpb25zLmxlbmd0aCA9PT0gMSAmJiAhKHZhcktpbmQgIT09IF90b2tlbnR5cGUudHlwZXMuX3ZhciAmJiBfaW5pdC5kZWNsYXJhdGlvbnNbMF0uaW5pdCkpcmV0dXJuIHRoaXMucGFyc2VGb3JJbihub2RlLF9pbml0KTtyZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLF9pbml0KTt9dmFyIHJlZlNob3J0aGFuZERlZmF1bHRQb3M9e3N0YXJ0OjB9O3ZhciBpbml0PXRoaXMucGFyc2VFeHByZXNzaW9uKHRydWUscmVmU2hvcnRoYW5kRGVmYXVsdFBvcyk7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pbiB8fCB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiB0aGlzLmlzQ29udGV4dHVhbChcIm9mXCIpKXt0aGlzLnRvQXNzaWduYWJsZShpbml0KTt0aGlzLmNoZWNrTFZhbChpbml0KTtyZXR1cm4gdGhpcy5wYXJzZUZvckluKG5vZGUsaW5pdCk7fWVsc2UgaWYocmVmU2hvcnRoYW5kRGVmYXVsdFBvcy5zdGFydCl7dGhpcy51bmV4cGVjdGVkKHJlZlNob3J0aGFuZERlZmF1bHRQb3Muc3RhcnQpO31yZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLGluaXQpO307cHAucGFyc2VGdW5jdGlvblN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUpe3RoaXMubmV4dCgpO3JldHVybiB0aGlzLnBhcnNlRnVuY3Rpb24obm9kZSx0cnVlKTt9O3BwLnBhcnNlSWZTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTtub2RlLnRlc3QgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7bm9kZS5jb25zZXF1ZW50ID0gdGhpcy5wYXJzZVN0YXRlbWVudChmYWxzZSk7bm9kZS5hbHRlcm5hdGUgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9lbHNlKT90aGlzLnBhcnNlU3RhdGVtZW50KGZhbHNlKTpudWxsO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIklmU3RhdGVtZW50XCIpO307cHAucGFyc2VSZXR1cm5TdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXtpZighdGhpcy5pbkZ1bmN0aW9uICYmICF0aGlzLm9wdGlvbnMuYWxsb3dSZXR1cm5PdXRzaWRlRnVuY3Rpb24pdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LFwiJ3JldHVybicgb3V0c2lkZSBvZiBmdW5jdGlvblwiKTt0aGlzLm5leHQoKTsgLy8gSW4gYHJldHVybmAgKGFuZCBgYnJlYWtgL2Bjb250aW51ZWApLCB0aGUga2V5d29yZHMgd2l0aFxuLy8gb3B0aW9uYWwgYXJndW1lbnRzLCB3ZSBlYWdlcmx5IGxvb2sgZm9yIGEgc2VtaWNvbG9uIG9yIHRoZVxuLy8gcG9zc2liaWxpdHkgdG8gaW5zZXJ0IG9uZS5cbmlmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSkgfHwgdGhpcy5pbnNlcnRTZW1pY29sb24oKSlub2RlLmFyZ3VtZW50ID0gbnVsbDtlbHNlIHtub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTt0aGlzLnNlbWljb2xvbigpO31yZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJSZXR1cm5TdGF0ZW1lbnRcIik7fTtwcC5wYXJzZVN3aXRjaFN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUpe3RoaXMubmV4dCgpO25vZGUuZGlzY3JpbWluYW50ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO25vZGUuY2FzZXMgPSBbXTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7dGhpcy5sYWJlbHMucHVzaChzd2l0Y2hMYWJlbCk7IC8vIFN0YXRlbWVudHMgdW5kZXIgbXVzdCBiZSBncm91cGVkIChieSBsYWJlbCkgaW4gU3dpdGNoQ2FzZVxuLy8gbm9kZXMuIGBjdXJgIGlzIHVzZWQgdG8ga2VlcCB0aGUgbm9kZSB0aGF0IHdlIGFyZSBjdXJyZW50bHlcbi8vIGFkZGluZyBzdGF0ZW1lbnRzIHRvLlxuZm9yKHZhciBjdXIsc2F3RGVmYXVsdD1mYWxzZTt0aGlzLnR5cGUgIT0gX3Rva2VudHlwZS50eXBlcy5icmFjZVI7KSB7aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9jYXNlIHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZGVmYXVsdCl7dmFyIGlzQ2FzZT10aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2Nhc2U7aWYoY3VyKXRoaXMuZmluaXNoTm9kZShjdXIsXCJTd2l0Y2hDYXNlXCIpO25vZGUuY2FzZXMucHVzaChjdXIgPSB0aGlzLnN0YXJ0Tm9kZSgpKTtjdXIuY29uc2VxdWVudCA9IFtdO3RoaXMubmV4dCgpO2lmKGlzQ2FzZSl7Y3VyLnRlc3QgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO31lbHNlIHtpZihzYXdEZWZhdWx0KXRoaXMucmFpc2UodGhpcy5sYXN0VG9rU3RhcnQsXCJNdWx0aXBsZSBkZWZhdWx0IGNsYXVzZXNcIik7c2F3RGVmYXVsdCA9IHRydWU7Y3VyLnRlc3QgPSBudWxsO310aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmNvbG9uKTt9ZWxzZSB7aWYoIWN1cil0aGlzLnVuZXhwZWN0ZWQoKTtjdXIuY29uc2VxdWVudC5wdXNoKHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSkpO319aWYoY3VyKXRoaXMuZmluaXNoTm9kZShjdXIsXCJTd2l0Y2hDYXNlXCIpO3RoaXMubmV4dCgpOyAvLyBDbG9zaW5nIGJyYWNlXG50aGlzLmxhYmVscy5wb3AoKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJTd2l0Y2hTdGF0ZW1lbnRcIik7fTtwcC5wYXJzZVRocm93U3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7aWYoX3doaXRlc3BhY2UubGluZUJyZWFrLnRlc3QodGhpcy5pbnB1dC5zbGljZSh0aGlzLmxhc3RUb2tFbmQsdGhpcy5zdGFydCkpKXRoaXMucmFpc2UodGhpcy5sYXN0VG9rRW5kLFwiSWxsZWdhbCBuZXdsaW5lIGFmdGVyIHRocm93XCIpO25vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO3RoaXMuc2VtaWNvbG9uKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiVGhyb3dTdGF0ZW1lbnRcIik7fTsgLy8gUmV1c2VkIGVtcHR5IGFycmF5IGFkZGVkIGZvciBub2RlIGZpZWxkcyB0aGF0IGFyZSBhbHdheXMgZW1wdHkuXG52YXIgZW1wdHk9W107cHAucGFyc2VUcnlTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTtub2RlLmJsb2NrID0gdGhpcy5wYXJzZUJsb2NrKCk7bm9kZS5oYW5kbGVyID0gbnVsbDtpZih0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2NhdGNoKXt2YXIgY2xhdXNlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlbkwpO2NsYXVzZS5wYXJhbSA9IHRoaXMucGFyc2VCaW5kaW5nQXRvbSgpO3RoaXMuY2hlY2tMVmFsKGNsYXVzZS5wYXJhbSx0cnVlKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuUik7Y2xhdXNlLmd1YXJkID0gbnVsbDtjbGF1c2UuYm9keSA9IHRoaXMucGFyc2VCbG9jaygpO25vZGUuaGFuZGxlciA9IHRoaXMuZmluaXNoTm9kZShjbGF1c2UsXCJDYXRjaENsYXVzZVwiKTt9bm9kZS5ndWFyZGVkSGFuZGxlcnMgPSBlbXB0eTtub2RlLmZpbmFsaXplciA9IHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuX2ZpbmFsbHkpP3RoaXMucGFyc2VCbG9jaygpOm51bGw7aWYoIW5vZGUuaGFuZGxlciAmJiAhbm9kZS5maW5hbGl6ZXIpdGhpcy5yYWlzZShub2RlLnN0YXJ0LFwiTWlzc2luZyBjYXRjaCBvciBmaW5hbGx5IGNsYXVzZVwiKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJUcnlTdGF0ZW1lbnRcIik7fTtwcC5wYXJzZVZhclN0YXRlbWVudCA9IGZ1bmN0aW9uKG5vZGUsa2luZCl7dGhpcy5uZXh0KCk7dGhpcy5wYXJzZVZhcihub2RlLGZhbHNlLGtpbmQpO3RoaXMuc2VtaWNvbG9uKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiVmFyaWFibGVEZWNsYXJhdGlvblwiKTt9O3BwLnBhcnNlV2hpbGVTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTtub2RlLnRlc3QgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7dGhpcy5sYWJlbHMucHVzaChsb29wTGFiZWwpO25vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO3RoaXMubGFiZWxzLnBvcCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIldoaWxlU3RhdGVtZW50XCIpO307cHAucGFyc2VXaXRoU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7aWYodGhpcy5zdHJpY3QpdGhpcy5yYWlzZSh0aGlzLnN0YXJ0LFwiJ3dpdGgnIGluIHN0cmljdCBtb2RlXCIpO3RoaXMubmV4dCgpO25vZGUub2JqZWN0ID0gdGhpcy5wYXJzZVBhcmVuRXhwcmVzc2lvbigpO25vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIldpdGhTdGF0ZW1lbnRcIik7fTtwcC5wYXJzZUVtcHR5U3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSl7dGhpcy5uZXh0KCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiRW1wdHlTdGF0ZW1lbnRcIik7fTtwcC5wYXJzZUxhYmVsZWRTdGF0ZW1lbnQgPSBmdW5jdGlvbihub2RlLG1heWJlTmFtZSxleHByKXtmb3IodmFyIGk9MDtpIDwgdGhpcy5sYWJlbHMubGVuZ3RoOysraSkge2lmKHRoaXMubGFiZWxzW2ldLm5hbWUgPT09IG1heWJlTmFtZSl0aGlzLnJhaXNlKGV4cHIuc3RhcnQsXCJMYWJlbCAnXCIgKyBtYXliZU5hbWUgKyBcIicgaXMgYWxyZWFkeSBkZWNsYXJlZFwiKTt9dmFyIGtpbmQ9dGhpcy50eXBlLmlzTG9vcD9cImxvb3BcIjp0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX3N3aXRjaD9cInN3aXRjaFwiOm51bGw7Zm9yKHZhciBpPXRoaXMubGFiZWxzLmxlbmd0aCAtIDE7aSA+PSAwO2ktLSkge3ZhciBsYWJlbD10aGlzLmxhYmVsc1tpXTtpZihsYWJlbC5zdGF0ZW1lbnRTdGFydCA9PSBub2RlLnN0YXJ0KXtsYWJlbC5zdGF0ZW1lbnRTdGFydCA9IHRoaXMuc3RhcnQ7bGFiZWwua2luZCA9IGtpbmQ7fWVsc2UgYnJlYWs7fXRoaXMubGFiZWxzLnB1c2goe25hbWU6bWF5YmVOYW1lLGtpbmQ6a2luZCxzdGF0ZW1lbnRTdGFydDp0aGlzLnN0YXJ0fSk7bm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudCh0cnVlKTt0aGlzLmxhYmVscy5wb3AoKTtub2RlLmxhYmVsID0gZXhwcjtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJMYWJlbGVkU3RhdGVtZW50XCIpO307cHAucGFyc2VFeHByZXNzaW9uU3RhdGVtZW50ID0gZnVuY3Rpb24obm9kZSxleHByKXtub2RlLmV4cHJlc3Npb24gPSBleHByO3RoaXMuc2VtaWNvbG9uKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiRXhwcmVzc2lvblN0YXRlbWVudFwiKTt9OyAvLyBQYXJzZSBhIHNlbWljb2xvbi1lbmNsb3NlZCBibG9jayBvZiBzdGF0ZW1lbnRzLCBoYW5kbGluZyBgXCJ1c2Vcbi8vIHN0cmljdFwiYCBkZWNsYXJhdGlvbnMgd2hlbiBgYWxsb3dTdHJpY3RgIGlzIHRydWUgKHVzZWQgZm9yXG4vLyBmdW5jdGlvbiBib2RpZXMpLlxucHAucGFyc2VCbG9jayA9IGZ1bmN0aW9uKGFsbG93U3RyaWN0KXt2YXIgbm9kZT10aGlzLnN0YXJ0Tm9kZSgpLGZpcnN0PXRydWUsb2xkU3RyaWN0PXVuZGVmaW5lZDtub2RlLmJvZHkgPSBbXTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7d2hpbGUoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge3ZhciBzdG10PXRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSk7bm9kZS5ib2R5LnB1c2goc3RtdCk7aWYoZmlyc3QgJiYgYWxsb3dTdHJpY3QgJiYgdGhpcy5pc1VzZVN0cmljdChzdG10KSl7b2xkU3RyaWN0ID0gdGhpcy5zdHJpY3Q7dGhpcy5zZXRTdHJpY3QodGhpcy5zdHJpY3QgPSB0cnVlKTt9Zmlyc3QgPSBmYWxzZTt9aWYob2xkU3RyaWN0ID09PSBmYWxzZSl0aGlzLnNldFN0cmljdChmYWxzZSk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiQmxvY2tTdGF0ZW1lbnRcIik7fTsgLy8gUGFyc2UgYSByZWd1bGFyIGBmb3JgIGxvb3AuIFRoZSBkaXNhbWJpZ3VhdGlvbiBjb2RlIGluXG4vLyBgcGFyc2VTdGF0ZW1lbnRgIHdpbGwgYWxyZWFkeSBoYXZlIHBhcnNlZCB0aGUgaW5pdCBzdGF0ZW1lbnQgb3Jcbi8vIGV4cHJlc3Npb24uXG5wcC5wYXJzZUZvciA9IGZ1bmN0aW9uKG5vZGUsaW5pdCl7bm9kZS5pbml0ID0gaW5pdDt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpO25vZGUudGVzdCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zZW1pP251bGw6dGhpcy5wYXJzZUV4cHJlc3Npb24oKTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnNlbWkpO25vZGUudXBkYXRlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuUj9udWxsOnRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO25vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO3RoaXMubGFiZWxzLnBvcCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkZvclN0YXRlbWVudFwiKTt9OyAvLyBQYXJzZSBhIGBmb3JgL2BpbmAgYW5kIGBmb3JgL2BvZmAgbG9vcCwgd2hpY2ggYXJlIGFsbW9zdFxuLy8gc2FtZSBmcm9tIHBhcnNlcidzIHBlcnNwZWN0aXZlLlxucHAucGFyc2VGb3JJbiA9IGZ1bmN0aW9uKG5vZGUsaW5pdCl7dmFyIHR5cGU9dGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pbj9cIkZvckluU3RhdGVtZW50XCI6XCJGb3JPZlN0YXRlbWVudFwiO3RoaXMubmV4dCgpO25vZGUubGVmdCA9IGluaXQ7bm9kZS5yaWdodCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIpO25vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoZmFsc2UpO3RoaXMubGFiZWxzLnBvcCgpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSx0eXBlKTt9OyAvLyBQYXJzZSBhIGxpc3Qgb2YgdmFyaWFibGUgZGVjbGFyYXRpb25zLlxucHAucGFyc2VWYXIgPSBmdW5jdGlvbihub2RlLGlzRm9yLGtpbmQpe25vZGUuZGVjbGFyYXRpb25zID0gW107bm9kZS5raW5kID0ga2luZC5rZXl3b3JkO2Zvcig7Oykge3ZhciBkZWNsPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5wYXJzZVZhcklkKGRlY2wpO2lmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuZXEpKXtkZWNsLmluaXQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oaXNGb3IpO31lbHNlIGlmKGtpbmQgPT09IF90b2tlbnR5cGUudHlwZXMuX2NvbnN0ICYmICEodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pbiB8fCB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNiAmJiB0aGlzLmlzQ29udGV4dHVhbChcIm9mXCIpKSl7dGhpcy51bmV4cGVjdGVkKCk7fWVsc2UgaWYoZGVjbC5pZC50eXBlICE9IFwiSWRlbnRpZmllclwiICYmICEoaXNGb3IgJiYgKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5faW4gfHwgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkpKXt0aGlzLnJhaXNlKHRoaXMubGFzdFRva0VuZCxcIkNvbXBsZXggYmluZGluZyBwYXR0ZXJucyByZXF1aXJlIGFuIGluaXRpYWxpemF0aW9uIHZhbHVlXCIpO31lbHNlIHtkZWNsLmluaXQgPSBudWxsO31ub2RlLmRlY2xhcmF0aW9ucy5wdXNoKHRoaXMuZmluaXNoTm9kZShkZWNsLFwiVmFyaWFibGVEZWNsYXJhdG9yXCIpKTtpZighdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5jb21tYSkpYnJlYWs7fXJldHVybiBub2RlO307cHAucGFyc2VWYXJJZCA9IGZ1bmN0aW9uKGRlY2wpe2RlY2wuaWQgPSB0aGlzLnBhcnNlQmluZGluZ0F0b20oKTt0aGlzLmNoZWNrTFZhbChkZWNsLmlkLHRydWUpO307IC8vIFBhcnNlIGEgZnVuY3Rpb24gZGVjbGFyYXRpb24gb3IgbGl0ZXJhbCAoZGVwZW5kaW5nIG9uIHRoZVxuLy8gYGlzU3RhdGVtZW50YCBwYXJhbWV0ZXIpLlxucHAucGFyc2VGdW5jdGlvbiA9IGZ1bmN0aW9uKG5vZGUsaXNTdGF0ZW1lbnQsYWxsb3dFeHByZXNzaW9uQm9keSl7dGhpcy5pbml0RnVuY3Rpb24obm9kZSk7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpbm9kZS5nZW5lcmF0b3IgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO2lmKGlzU3RhdGVtZW50IHx8IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKW5vZGUuaWQgPSB0aGlzLnBhcnNlSWRlbnQoKTt0aGlzLnBhcnNlRnVuY3Rpb25QYXJhbXMobm9kZSk7dGhpcy5wYXJzZUZ1bmN0aW9uQm9keShub2RlLGFsbG93RXhwcmVzc2lvbkJvZHkpO3JldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSxpc1N0YXRlbWVudD9cIkZ1bmN0aW9uRGVjbGFyYXRpb25cIjpcIkZ1bmN0aW9uRXhwcmVzc2lvblwiKTt9O3BwLnBhcnNlRnVuY3Rpb25QYXJhbXMgPSBmdW5jdGlvbihub2RlKXt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7bm9kZS5wYXJhbXMgPSB0aGlzLnBhcnNlQmluZGluZ0xpc3QoX3Rva2VudHlwZS50eXBlcy5wYXJlblIsZmFsc2UsZmFsc2UpO307IC8vIFBhcnNlIGEgY2xhc3MgZGVjbGFyYXRpb24gb3IgbGl0ZXJhbCAoZGVwZW5kaW5nIG9uIHRoZVxuLy8gYGlzU3RhdGVtZW50YCBwYXJhbWV0ZXIpLlxucHAucGFyc2VDbGFzcyA9IGZ1bmN0aW9uKG5vZGUsaXNTdGF0ZW1lbnQpe3RoaXMubmV4dCgpO3RoaXMucGFyc2VDbGFzc0lkKG5vZGUsaXNTdGF0ZW1lbnQpO3RoaXMucGFyc2VDbGFzc1N1cGVyKG5vZGUpO3ZhciBjbGFzc0JvZHk9dGhpcy5zdGFydE5vZGUoKTt2YXIgaGFkQ29uc3RydWN0b3I9ZmFsc2U7Y2xhc3NCb2R5LmJvZHkgPSBbXTt0aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7d2hpbGUoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge2lmKHRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuc2VtaSkpY29udGludWU7dmFyIG1ldGhvZD10aGlzLnN0YXJ0Tm9kZSgpO3ZhciBpc0dlbmVyYXRvcj10aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLnN0YXIpO3ZhciBpc01heWJlU3RhdGljPXRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lICYmIHRoaXMudmFsdWUgPT09IFwic3RhdGljXCI7dGhpcy5wYXJzZVByb3BlcnR5TmFtZShtZXRob2QpO21ldGhvZFtcInN0YXRpY1wiXSA9IGlzTWF5YmVTdGF0aWMgJiYgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTDtpZihtZXRob2RbXCJzdGF0aWNcIl0pe2lmKGlzR2VuZXJhdG9yKXRoaXMudW5leHBlY3RlZCgpO2lzR2VuZXJhdG9yID0gdGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKTt0aGlzLnBhcnNlUHJvcGVydHlOYW1lKG1ldGhvZCk7fW1ldGhvZC5raW5kID0gXCJtZXRob2RcIjt2YXIgaXNHZXRTZXQ9ZmFsc2U7aWYoIW1ldGhvZC5jb21wdXRlZCl7dmFyIGtleT1tZXRob2Qua2V5O2lmKCFpc0dlbmVyYXRvciAmJiBrZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgdGhpcy50eXBlICE9PSBfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCAmJiAoa2V5Lm5hbWUgPT09IFwiZ2V0XCIgfHwga2V5Lm5hbWUgPT09IFwic2V0XCIpKXtpc0dldFNldCA9IHRydWU7bWV0aG9kLmtpbmQgPSBrZXkubmFtZTtrZXkgPSB0aGlzLnBhcnNlUHJvcGVydHlOYW1lKG1ldGhvZCk7fWlmKCFtZXRob2RbXCJzdGF0aWNcIl0gJiYgKGtleS50eXBlID09PSBcIklkZW50aWZpZXJcIiAmJiBrZXkubmFtZSA9PT0gXCJjb25zdHJ1Y3RvclwiIHx8IGtleS50eXBlID09PSBcIkxpdGVyYWxcIiAmJiBrZXkudmFsdWUgPT09IFwiY29uc3RydWN0b3JcIikpe2lmKGhhZENvbnN0cnVjdG9yKXRoaXMucmFpc2Uoa2V5LnN0YXJ0LFwiRHVwbGljYXRlIGNvbnN0cnVjdG9yIGluIHRoZSBzYW1lIGNsYXNzXCIpO2lmKGlzR2V0U2V0KXRoaXMucmFpc2Uoa2V5LnN0YXJ0LFwiQ29uc3RydWN0b3IgY2FuJ3QgaGF2ZSBnZXQvc2V0IG1vZGlmaWVyXCIpO2lmKGlzR2VuZXJhdG9yKXRoaXMucmFpc2Uoa2V5LnN0YXJ0LFwiQ29uc3RydWN0b3IgY2FuJ3QgYmUgYSBnZW5lcmF0b3JcIik7bWV0aG9kLmtpbmQgPSBcImNvbnN0cnVjdG9yXCI7aGFkQ29uc3RydWN0b3IgPSB0cnVlO319dGhpcy5wYXJzZUNsYXNzTWV0aG9kKGNsYXNzQm9keSxtZXRob2QsaXNHZW5lcmF0b3IpO2lmKGlzR2V0U2V0KXt2YXIgcGFyYW1Db3VudD1tZXRob2Qua2luZCA9PT0gXCJnZXRcIj8wOjE7aWYobWV0aG9kLnZhbHVlLnBhcmFtcy5sZW5ndGggIT09IHBhcmFtQ291bnQpe3ZhciBzdGFydD1tZXRob2QudmFsdWUuc3RhcnQ7aWYobWV0aG9kLmtpbmQgPT09IFwiZ2V0XCIpdGhpcy5yYWlzZShzdGFydCxcImdldHRlciBzaG91bGQgaGF2ZSBubyBwYXJhbXNcIik7ZWxzZSB0aGlzLnJhaXNlKHN0YXJ0LFwic2V0dGVyIHNob3VsZCBoYXZlIGV4YWN0bHkgb25lIHBhcmFtXCIpO319fW5vZGUuYm9keSA9IHRoaXMuZmluaXNoTm9kZShjbGFzc0JvZHksXCJDbGFzc0JvZHlcIik7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLGlzU3RhdGVtZW50P1wiQ2xhc3NEZWNsYXJhdGlvblwiOlwiQ2xhc3NFeHByZXNzaW9uXCIpO307cHAucGFyc2VDbGFzc01ldGhvZCA9IGZ1bmN0aW9uKGNsYXNzQm9keSxtZXRob2QsaXNHZW5lcmF0b3Ipe21ldGhvZC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoaXNHZW5lcmF0b3IpO2NsYXNzQm9keS5ib2R5LnB1c2godGhpcy5maW5pc2hOb2RlKG1ldGhvZCxcIk1ldGhvZERlZmluaXRpb25cIikpO307cHAucGFyc2VDbGFzc0lkID0gZnVuY3Rpb24obm9kZSxpc1N0YXRlbWVudCl7bm9kZS5pZCA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lP3RoaXMucGFyc2VJZGVudCgpOmlzU3RhdGVtZW50P3RoaXMudW5leHBlY3RlZCgpOm51bGw7fTtwcC5wYXJzZUNsYXNzU3VwZXIgPSBmdW5jdGlvbihub2RlKXtub2RlLnN1cGVyQ2xhc3MgPSB0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLl9leHRlbmRzKT90aGlzLnBhcnNlRXhwclN1YnNjcmlwdHMoKTpudWxsO307IC8vIFBhcnNlcyBtb2R1bGUgZXhwb3J0IGRlY2xhcmF0aW9uLlxucHAucGFyc2VFeHBvcnQgPSBmdW5jdGlvbihub2RlKXt0aGlzLm5leHQoKTsgLy8gZXhwb3J0ICogZnJvbSAnLi4uJ1xuaWYodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5zdGFyKSl7dGhpcy5leHBlY3RDb250ZXh0dWFsKFwiZnJvbVwiKTtub2RlLnNvdXJjZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmc/dGhpcy5wYXJzZUV4cHJBdG9tKCk6dGhpcy51bmV4cGVjdGVkKCk7dGhpcy5zZW1pY29sb24oKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJFeHBvcnRBbGxEZWNsYXJhdGlvblwiKTt9aWYodGhpcy5lYXQoX3Rva2VudHlwZS50eXBlcy5fZGVmYXVsdCkpeyAvLyBleHBvcnQgZGVmYXVsdCAuLi5cbnZhciBleHByPXRoaXMucGFyc2VNYXliZUFzc2lnbigpO3ZhciBuZWVkc1NlbWk9dHJ1ZTtpZihleHByLnR5cGUgPT0gXCJGdW5jdGlvbkV4cHJlc3Npb25cIiB8fCBleHByLnR5cGUgPT0gXCJDbGFzc0V4cHJlc3Npb25cIil7bmVlZHNTZW1pID0gZmFsc2U7aWYoZXhwci5pZCl7ZXhwci50eXBlID0gZXhwci50eXBlID09IFwiRnVuY3Rpb25FeHByZXNzaW9uXCI/XCJGdW5jdGlvbkRlY2xhcmF0aW9uXCI6XCJDbGFzc0RlY2xhcmF0aW9uXCI7fX1ub2RlLmRlY2xhcmF0aW9uID0gZXhwcjtpZihuZWVkc1NlbWkpdGhpcy5zZW1pY29sb24oKTtyZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJFeHBvcnREZWZhdWx0RGVjbGFyYXRpb25cIik7fSAvLyBleHBvcnQgdmFyfGNvbnN0fGxldHxmdW5jdGlvbnxjbGFzcyAuLi5cbmlmKHRoaXMuc2hvdWxkUGFyc2VFeHBvcnRTdGF0ZW1lbnQoKSl7bm9kZS5kZWNsYXJhdGlvbiA9IHRoaXMucGFyc2VTdGF0ZW1lbnQodHJ1ZSk7bm9kZS5zcGVjaWZpZXJzID0gW107bm9kZS5zb3VyY2UgPSBudWxsO31lbHNlIHsgLy8gZXhwb3J0IHsgeCwgeSBhcyB6IH0gW2Zyb20gJy4uLiddXG5ub2RlLmRlY2xhcmF0aW9uID0gbnVsbDtub2RlLnNwZWNpZmllcnMgPSB0aGlzLnBhcnNlRXhwb3J0U3BlY2lmaWVycygpO2lmKHRoaXMuZWF0Q29udGV4dHVhbChcImZyb21cIikpe25vZGUuc291cmNlID0gdGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0cmluZz90aGlzLnBhcnNlRXhwckF0b20oKTp0aGlzLnVuZXhwZWN0ZWQoKTt9ZWxzZSB7bm9kZS5zb3VyY2UgPSBudWxsO310aGlzLnNlbWljb2xvbigpO31yZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsXCJFeHBvcnROYW1lZERlY2xhcmF0aW9uXCIpO307cHAuc2hvdWxkUGFyc2VFeHBvcnRTdGF0ZW1lbnQgPSBmdW5jdGlvbigpe3JldHVybiB0aGlzLnR5cGUua2V5d29yZDt9OyAvLyBQYXJzZXMgYSBjb21tYS1zZXBhcmF0ZWQgbGlzdCBvZiBtb2R1bGUgZXhwb3J0cy5cbnBwLnBhcnNlRXhwb3J0U3BlY2lmaWVycyA9IGZ1bmN0aW9uKCl7dmFyIG5vZGVzPVtdLGZpcnN0PXRydWU7IC8vIGV4cG9ydCB7IHgsIHkgYXMgeiB9IFtmcm9tICcuLi4nXVxudGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5icmFjZUwpO3doaWxlKCF0aGlzLmVhdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlUikpIHtpZighZmlyc3Qpe3RoaXMuZXhwZWN0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpO2lmKHRoaXMuYWZ0ZXJUcmFpbGluZ0NvbW1hKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSlicmVhazt9ZWxzZSBmaXJzdCA9IGZhbHNlO3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7bm9kZS5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCh0aGlzLnR5cGUgPT09IF90b2tlbnR5cGUudHlwZXMuX2RlZmF1bHQpO25vZGUuZXhwb3J0ZWQgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKT90aGlzLnBhcnNlSWRlbnQodHJ1ZSk6bm9kZS5sb2NhbDtub2Rlcy5wdXNoKHRoaXMuZmluaXNoTm9kZShub2RlLFwiRXhwb3J0U3BlY2lmaWVyXCIpKTt9cmV0dXJuIG5vZGVzO307IC8vIFBhcnNlcyBpbXBvcnQgZGVjbGFyYXRpb24uXG5wcC5wYXJzZUltcG9ydCA9IGZ1bmN0aW9uKG5vZGUpe3RoaXMubmV4dCgpOyAvLyBpbXBvcnQgJy4uLidcbmlmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcpe25vZGUuc3BlY2lmaWVycyA9IGVtcHR5O25vZGUuc291cmNlID0gdGhpcy5wYXJzZUV4cHJBdG9tKCk7fWVsc2Uge25vZGUuc3BlY2lmaWVycyA9IHRoaXMucGFyc2VJbXBvcnRTcGVjaWZpZXJzKCk7dGhpcy5leHBlY3RDb250ZXh0dWFsKFwiZnJvbVwiKTtub2RlLnNvdXJjZSA9IHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmc/dGhpcy5wYXJzZUV4cHJBdG9tKCk6dGhpcy51bmV4cGVjdGVkKCk7fXRoaXMuc2VtaWNvbG9uKCk7cmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLFwiSW1wb3J0RGVjbGFyYXRpb25cIik7fTsgLy8gUGFyc2VzIGEgY29tbWEtc2VwYXJhdGVkIGxpc3Qgb2YgbW9kdWxlIGltcG9ydHMuXG5wcC5wYXJzZUltcG9ydFNwZWNpZmllcnMgPSBmdW5jdGlvbigpe3ZhciBub2Rlcz1bXSxmaXJzdD10cnVlO2lmKHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5uYW1lKXsgLy8gaW1wb3J0IGRlZmF1bHRPYmosIHsgeCwgeSBhcyB6IH0gZnJvbSAnLi4uJ1xudmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTtub2RlLmxvY2FsID0gdGhpcy5wYXJzZUlkZW50KCk7dGhpcy5jaGVja0xWYWwobm9kZS5sb2NhbCx0cnVlKTtub2Rlcy5wdXNoKHRoaXMuZmluaXNoTm9kZShub2RlLFwiSW1wb3J0RGVmYXVsdFNwZWNpZmllclwiKSk7aWYoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuY29tbWEpKXJldHVybiBub2Rlczt9aWYodGhpcy50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLnN0YXIpe3ZhciBub2RlPXRoaXMuc3RhcnROb2RlKCk7dGhpcy5uZXh0KCk7dGhpcy5leHBlY3RDb250ZXh0dWFsKFwiYXNcIik7bm9kZS5sb2NhbCA9IHRoaXMucGFyc2VJZGVudCgpO3RoaXMuY2hlY2tMVmFsKG5vZGUubG9jYWwsdHJ1ZSk7bm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkltcG9ydE5hbWVzcGFjZVNwZWNpZmllclwiKSk7cmV0dXJuIG5vZGVzO310aGlzLmV4cGVjdChfdG9rZW50eXBlLnR5cGVzLmJyYWNlTCk7d2hpbGUoIXRoaXMuZWF0KF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKSkge2lmKCFmaXJzdCl7dGhpcy5leHBlY3QoX3Rva2VudHlwZS50eXBlcy5jb21tYSk7aWYodGhpcy5hZnRlclRyYWlsaW5nQ29tbWEoX3Rva2VudHlwZS50eXBlcy5icmFjZVIpKWJyZWFrO31lbHNlIGZpcnN0ID0gZmFsc2U7dmFyIG5vZGU9dGhpcy5zdGFydE5vZGUoKTtub2RlLmltcG9ydGVkID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO25vZGUubG9jYWwgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKT90aGlzLnBhcnNlSWRlbnQoKTpub2RlLmltcG9ydGVkO3RoaXMuY2hlY2tMVmFsKG5vZGUubG9jYWwsdHJ1ZSk7bm9kZXMucHVzaCh0aGlzLmZpbmlzaE5vZGUobm9kZSxcIkltcG9ydFNwZWNpZmllclwiKSk7fXJldHVybiBub2Rlczt9O30se1wiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTI6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpeyAvLyBUaGUgYWxnb3JpdGhtIHVzZWQgdG8gZGV0ZXJtaW5lIHdoZXRoZXIgYSByZWdleHAgY2FuIGFwcGVhciBhdCBhXG4vLyBnaXZlbiBwb2ludCBpbiB0aGUgcHJvZ3JhbSBpcyBsb29zZWx5IGJhc2VkIG9uIHN3ZWV0LmpzJyBhcHByb2FjaC5cbi8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vbW96aWxsYS9zd2VldC5qcy93aWtpL2Rlc2lnblxuXCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtmdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsQ29uc3RydWN0b3Ipe2lmKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3Rvcikpe3Rocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7fX12YXIgX3N0YXRlPV9kZXJlcV8oXCIuL3N0YXRlXCIpO3ZhciBfdG9rZW50eXBlPV9kZXJlcV8oXCIuL3Rva2VudHlwZVwiKTt2YXIgX3doaXRlc3BhY2U9X2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTt2YXIgVG9rQ29udGV4dD1mdW5jdGlvbiBUb2tDb250ZXh0KHRva2VuLGlzRXhwcixwcmVzZXJ2ZVNwYWNlLG92ZXJyaWRlKXtfY2xhc3NDYWxsQ2hlY2sodGhpcyxUb2tDb250ZXh0KTt0aGlzLnRva2VuID0gdG9rZW47dGhpcy5pc0V4cHIgPSAhIWlzRXhwcjt0aGlzLnByZXNlcnZlU3BhY2UgPSAhIXByZXNlcnZlU3BhY2U7dGhpcy5vdmVycmlkZSA9IG92ZXJyaWRlO307ZXhwb3J0cy5Ub2tDb250ZXh0ID0gVG9rQ29udGV4dDt2YXIgdHlwZXM9e2Jfc3RhdDpuZXcgVG9rQ29udGV4dChcIntcIixmYWxzZSksYl9leHByOm5ldyBUb2tDb250ZXh0KFwie1wiLHRydWUpLGJfdG1wbDpuZXcgVG9rQ29udGV4dChcIiR7XCIsdHJ1ZSkscF9zdGF0Om5ldyBUb2tDb250ZXh0KFwiKFwiLGZhbHNlKSxwX2V4cHI6bmV3IFRva0NvbnRleHQoXCIoXCIsdHJ1ZSkscV90bXBsOm5ldyBUb2tDb250ZXh0KFwiYFwiLHRydWUsdHJ1ZSxmdW5jdGlvbihwKXtyZXR1cm4gcC5yZWFkVG1wbFRva2VuKCk7fSksZl9leHByOm5ldyBUb2tDb250ZXh0KFwiZnVuY3Rpb25cIix0cnVlKX07ZXhwb3J0cy50eXBlcyA9IHR5cGVzO3ZhciBwcD1fc3RhdGUuUGFyc2VyLnByb3RvdHlwZTtwcC5pbml0aWFsQ29udGV4dCA9IGZ1bmN0aW9uKCl7cmV0dXJuIFt0eXBlcy5iX3N0YXRdO307cHAuYnJhY2VJc0Jsb2NrID0gZnVuY3Rpb24ocHJldlR5cGUpe2lmKHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmNvbG9uKXt2YXIgX3BhcmVudD10aGlzLmN1ckNvbnRleHQoKTtpZihfcGFyZW50ID09PSB0eXBlcy5iX3N0YXQgfHwgX3BhcmVudCA9PT0gdHlwZXMuYl9leHByKXJldHVybiAhX3BhcmVudC5pc0V4cHI7fWlmKHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9yZXR1cm4pcmV0dXJuIF93aGl0ZXNwYWNlLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0VG9rRW5kLHRoaXMuc3RhcnQpKTtpZihwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZWxzZSB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5zZW1pIHx8IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVvZiB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5wYXJlblIpcmV0dXJuIHRydWU7aWYocHJldlR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5icmFjZUwpcmV0dXJuIHRoaXMuY3VyQ29udGV4dCgpID09PSB0eXBlcy5iX3N0YXQ7cmV0dXJuICF0aGlzLmV4cHJBbGxvd2VkO307cHAudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKHByZXZUeXBlKXt2YXIgdXBkYXRlPXVuZGVmaW5lZCx0eXBlPXRoaXMudHlwZTtpZih0eXBlLmtleXdvcmQgJiYgcHJldlR5cGUgPT0gX3Rva2VudHlwZS50eXBlcy5kb3QpdGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO2Vsc2UgaWYodXBkYXRlID0gdHlwZS51cGRhdGVDb250ZXh0KXVwZGF0ZS5jYWxsKHRoaXMscHJldlR5cGUpO2Vsc2UgdGhpcy5leHByQWxsb3dlZCA9IHR5cGUuYmVmb3JlRXhwcjt9OyAvLyBUb2tlbi1zcGVjaWZpYyBjb250ZXh0IHVwZGF0ZSBjb2RlXG5fdG9rZW50eXBlLnR5cGVzLnBhcmVuUi51cGRhdGVDb250ZXh0ID0gX3Rva2VudHlwZS50eXBlcy5icmFjZVIudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKCl7aWYodGhpcy5jb250ZXh0Lmxlbmd0aCA9PSAxKXt0aGlzLmV4cHJBbGxvd2VkID0gdHJ1ZTtyZXR1cm47fXZhciBvdXQ9dGhpcy5jb250ZXh0LnBvcCgpO2lmKG91dCA9PT0gdHlwZXMuYl9zdGF0ICYmIHRoaXMuY3VyQ29udGV4dCgpID09PSB0eXBlcy5mX2V4cHIpe3RoaXMuY29udGV4dC5wb3AoKTt0aGlzLmV4cHJBbGxvd2VkID0gZmFsc2U7fWVsc2UgaWYob3V0ID09PSB0eXBlcy5iX3RtcGwpe3RoaXMuZXhwckFsbG93ZWQgPSB0cnVlO31lbHNlIHt0aGlzLmV4cHJBbGxvd2VkID0gIW91dC5pc0V4cHI7fX07X3Rva2VudHlwZS50eXBlcy5icmFjZUwudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKHByZXZUeXBlKXt0aGlzLmNvbnRleHQucHVzaCh0aGlzLmJyYWNlSXNCbG9jayhwcmV2VHlwZSk/dHlwZXMuYl9zdGF0OnR5cGVzLmJfZXhwcik7dGhpcy5leHByQWxsb3dlZCA9IHRydWU7fTtfdG9rZW50eXBlLnR5cGVzLmRvbGxhckJyYWNlTC51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24oKXt0aGlzLmNvbnRleHQucHVzaCh0eXBlcy5iX3RtcGwpO3RoaXMuZXhwckFsbG93ZWQgPSB0cnVlO307X3Rva2VudHlwZS50eXBlcy5wYXJlbkwudXBkYXRlQ29udGV4dCA9IGZ1bmN0aW9uKHByZXZUeXBlKXt2YXIgc3RhdGVtZW50UGFyZW5zPXByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl9pZiB8fCBwcmV2VHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy5fZm9yIHx8IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl93aXRoIHx8IHByZXZUeXBlID09PSBfdG9rZW50eXBlLnR5cGVzLl93aGlsZTt0aGlzLmNvbnRleHQucHVzaChzdGF0ZW1lbnRQYXJlbnM/dHlwZXMucF9zdGF0OnR5cGVzLnBfZXhwcik7dGhpcy5leHByQWxsb3dlZCA9IHRydWU7fTtfdG9rZW50eXBlLnR5cGVzLmluY0RlYy51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24oKXsgLy8gdG9rRXhwckFsbG93ZWQgc3RheXMgdW5jaGFuZ2VkXG59O190b2tlbnR5cGUudHlwZXMuX2Z1bmN0aW9uLnVwZGF0ZUNvbnRleHQgPSBmdW5jdGlvbigpe2lmKHRoaXMuY3VyQ29udGV4dCgpICE9PSB0eXBlcy5iX3N0YXQpdGhpcy5jb250ZXh0LnB1c2godHlwZXMuZl9leHByKTt0aGlzLmV4cHJBbGxvd2VkID0gZmFsc2U7fTtfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZS51cGRhdGVDb250ZXh0ID0gZnVuY3Rpb24oKXtpZih0aGlzLmN1ckNvbnRleHQoKSA9PT0gdHlwZXMucV90bXBsKXRoaXMuY29udGV4dC5wb3AoKTtlbHNlIHRoaXMuY29udGV4dC5wdXNoKHR5cGVzLnFfdG1wbCk7dGhpcy5leHByQWxsb3dlZCA9IGZhbHNlO307fSx7XCIuL3N0YXRlXCI6MTAsXCIuL3Rva2VudHlwZVwiOjE0LFwiLi93aGl0ZXNwYWNlXCI6MTZ9XSwxMzpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XCJ1c2Ugc3RyaWN0XCI7ZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtmdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsQ29uc3RydWN0b3Ipe2lmKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3Rvcikpe3Rocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7fX12YXIgX2lkZW50aWZpZXI9X2RlcmVxXyhcIi4vaWRlbnRpZmllclwiKTt2YXIgX3Rva2VudHlwZT1fZGVyZXFfKFwiLi90b2tlbnR5cGVcIik7dmFyIF9zdGF0ZT1fZGVyZXFfKFwiLi9zdGF0ZVwiKTt2YXIgX2xvY3V0aWw9X2RlcmVxXyhcIi4vbG9jdXRpbFwiKTt2YXIgX3doaXRlc3BhY2U9X2RlcmVxXyhcIi4vd2hpdGVzcGFjZVwiKTsgLy8gT2JqZWN0IHR5cGUgdXNlZCB0byByZXByZXNlbnQgdG9rZW5zLiBOb3RlIHRoYXQgbm9ybWFsbHksIHRva2Vuc1xuLy8gc2ltcGx5IGV4aXN0IGFzIHByb3BlcnRpZXMgb24gdGhlIHBhcnNlciBvYmplY3QuIFRoaXMgaXMgb25seVxuLy8gdXNlZCBmb3IgdGhlIG9uVG9rZW4gY2FsbGJhY2sgYW5kIHRoZSBleHRlcm5hbCB0b2tlbml6ZXIuXG52YXIgVG9rZW49ZnVuY3Rpb24gVG9rZW4ocCl7X2NsYXNzQ2FsbENoZWNrKHRoaXMsVG9rZW4pO3RoaXMudHlwZSA9IHAudHlwZTt0aGlzLnZhbHVlID0gcC52YWx1ZTt0aGlzLnN0YXJ0ID0gcC5zdGFydDt0aGlzLmVuZCA9IHAuZW5kO2lmKHAub3B0aW9ucy5sb2NhdGlvbnMpdGhpcy5sb2MgPSBuZXcgX2xvY3V0aWwuU291cmNlTG9jYXRpb24ocCxwLnN0YXJ0TG9jLHAuZW5kTG9jKTtpZihwLm9wdGlvbnMucmFuZ2VzKXRoaXMucmFuZ2UgPSBbcC5zdGFydCxwLmVuZF07fSAvLyAjIyBUb2tlbml6ZXJcbjtleHBvcnRzLlRva2VuID0gVG9rZW47dmFyIHBwPV9zdGF0ZS5QYXJzZXIucHJvdG90eXBlOyAvLyBBcmUgd2UgcnVubmluZyB1bmRlciBSaGlubz9cbnZhciBpc1JoaW5vPXR5cGVvZiBQYWNrYWdlcyA9PSBcIm9iamVjdFwiICYmIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChQYWNrYWdlcykgPT0gXCJbb2JqZWN0IEphdmFQYWNrYWdlXVwiOyAvLyBNb3ZlIHRvIHRoZSBuZXh0IHRva2VuXG5wcC5uZXh0ID0gZnVuY3Rpb24oKXtpZih0aGlzLm9wdGlvbnMub25Ub2tlbil0aGlzLm9wdGlvbnMub25Ub2tlbihuZXcgVG9rZW4odGhpcykpO3RoaXMubGFzdFRva0VuZCA9IHRoaXMuZW5kO3RoaXMubGFzdFRva1N0YXJ0ID0gdGhpcy5zdGFydDt0aGlzLmxhc3RUb2tFbmRMb2MgPSB0aGlzLmVuZExvYzt0aGlzLmxhc3RUb2tTdGFydExvYyA9IHRoaXMuc3RhcnRMb2M7dGhpcy5uZXh0VG9rZW4oKTt9O3BwLmdldFRva2VuID0gZnVuY3Rpb24oKXt0aGlzLm5leHQoKTtyZXR1cm4gbmV3IFRva2VuKHRoaXMpO307IC8vIElmIHdlJ3JlIGluIGFuIEVTNiBlbnZpcm9ubWVudCwgbWFrZSBwYXJzZXJzIGl0ZXJhYmxlXG5pZih0eXBlb2YgU3ltYm9sICE9PSBcInVuZGVmaW5lZFwiKXBwW1N5bWJvbC5pdGVyYXRvcl0gPSBmdW5jdGlvbigpe3ZhciBzZWxmPXRoaXM7cmV0dXJuIHtuZXh0OmZ1bmN0aW9uIG5leHQoKXt2YXIgdG9rZW49c2VsZi5nZXRUb2tlbigpO3JldHVybiB7ZG9uZTp0b2tlbi50eXBlID09PSBfdG9rZW50eXBlLnR5cGVzLmVvZix2YWx1ZTp0b2tlbn07fX07fTsgLy8gVG9nZ2xlIHN0cmljdCBtb2RlLiBSZS1yZWFkcyB0aGUgbmV4dCBudW1iZXIgb3Igc3RyaW5nIHRvIHBsZWFzZVxuLy8gcGVkYW50aWMgdGVzdHMgKGBcInVzZSBzdHJpY3RcIjsgMDEwO2Agc2hvdWxkIGZhaWwpLlxucHAuc2V0U3RyaWN0ID0gZnVuY3Rpb24oc3RyaWN0KXt0aGlzLnN0cmljdCA9IHN0cmljdDtpZih0aGlzLnR5cGUgIT09IF90b2tlbnR5cGUudHlwZXMubnVtICYmIHRoaXMudHlwZSAhPT0gX3Rva2VudHlwZS50eXBlcy5zdHJpbmcpcmV0dXJuO3RoaXMucG9zID0gdGhpcy5zdGFydDtpZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKXt3aGlsZSh0aGlzLnBvcyA8IHRoaXMubGluZVN0YXJ0KSB7dGhpcy5saW5lU3RhcnQgPSB0aGlzLmlucHV0Lmxhc3RJbmRleE9mKFwiXFxuXCIsdGhpcy5saW5lU3RhcnQgLSAyKSArIDE7LS10aGlzLmN1ckxpbmU7fX10aGlzLm5leHRUb2tlbigpO307cHAuY3VyQ29udGV4dCA9IGZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMuY29udGV4dFt0aGlzLmNvbnRleHQubGVuZ3RoIC0gMV07fTsgLy8gUmVhZCBhIHNpbmdsZSB0b2tlbiwgdXBkYXRpbmcgdGhlIHBhcnNlciBvYmplY3QncyB0b2tlbi1yZWxhdGVkXG4vLyBwcm9wZXJ0aWVzLlxucHAubmV4dFRva2VuID0gZnVuY3Rpb24oKXt2YXIgY3VyQ29udGV4dD10aGlzLmN1ckNvbnRleHQoKTtpZighY3VyQ29udGV4dCB8fCAhY3VyQ29udGV4dC5wcmVzZXJ2ZVNwYWNlKXRoaXMuc2tpcFNwYWNlKCk7dGhpcy5zdGFydCA9IHRoaXMucG9zO2lmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpdGhpcy5zdGFydExvYyA9IHRoaXMuY3VyUG9zaXRpb24oKTtpZih0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aClyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmVvZik7aWYoY3VyQ29udGV4dC5vdmVycmlkZSlyZXR1cm4gY3VyQ29udGV4dC5vdmVycmlkZSh0aGlzKTtlbHNlIHRoaXMucmVhZFRva2VuKHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKSk7fTtwcC5yZWFkVG9rZW4gPSBmdW5jdGlvbihjb2RlKXsgLy8gSWRlbnRpZmllciBvciBrZXl3b3JkLiAnXFx1WFhYWCcgc2VxdWVuY2VzIGFyZSBhbGxvd2VkIGluXG4vLyBpZGVudGlmaWVycywgc28gJ1xcJyBhbHNvIGRpc3BhdGNoZXMgdG8gdGhhdC5cbmlmKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0KGNvZGUsdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHx8IGNvZGUgPT09IDkyIC8qICdcXCcgKi8pcmV0dXJuIHRoaXMucmVhZFdvcmQoKTtyZXR1cm4gdGhpcy5nZXRUb2tlbkZyb21Db2RlKGNvZGUpO307cHAuZnVsbENoYXJDb2RlQXRQb3MgPSBmdW5jdGlvbigpe3ZhciBjb2RlPXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7aWYoY29kZSA8PSAweGQ3ZmYgfHwgY29kZSA+PSAweGUwMDApcmV0dXJuIGNvZGU7dmFyIG5leHQ9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7cmV0dXJuIChjb2RlIDw8IDEwKSArIG5leHQgLSAweDM1ZmRjMDA7fTtwcC5za2lwQmxvY2tDb21tZW50ID0gZnVuY3Rpb24oKXt2YXIgc3RhcnRMb2M9dGhpcy5vcHRpb25zLm9uQ29tbWVudCAmJiB0aGlzLmN1clBvc2l0aW9uKCk7dmFyIHN0YXJ0PXRoaXMucG9zLGVuZD10aGlzLmlucHV0LmluZGV4T2YoXCIqL1wiLHRoaXMucG9zICs9IDIpO2lmKGVuZCA9PT0gLTEpdGhpcy5yYWlzZSh0aGlzLnBvcyAtIDIsXCJVbnRlcm1pbmF0ZWQgY29tbWVudFwiKTt0aGlzLnBvcyA9IGVuZCArIDI7aWYodGhpcy5vcHRpb25zLmxvY2F0aW9ucyl7X3doaXRlc3BhY2UubGluZUJyZWFrRy5sYXN0SW5kZXggPSBzdGFydDt2YXIgbWF0Y2g9dW5kZWZpbmVkO3doaWxlKChtYXRjaCA9IF93aGl0ZXNwYWNlLmxpbmVCcmVha0cuZXhlYyh0aGlzLmlucHV0KSkgJiYgbWF0Y2guaW5kZXggPCB0aGlzLnBvcykgeysrdGhpcy5jdXJMaW5lO3RoaXMubGluZVN0YXJ0ID0gbWF0Y2guaW5kZXggKyBtYXRjaFswXS5sZW5ndGg7fX1pZih0aGlzLm9wdGlvbnMub25Db21tZW50KXRoaXMub3B0aW9ucy5vbkNvbW1lbnQodHJ1ZSx0aGlzLmlucHV0LnNsaWNlKHN0YXJ0ICsgMixlbmQpLHN0YXJ0LHRoaXMucG9zLHN0YXJ0TG9jLHRoaXMuY3VyUG9zaXRpb24oKSk7fTtwcC5za2lwTGluZUNvbW1lbnQgPSBmdW5jdGlvbihzdGFydFNraXApe3ZhciBzdGFydD10aGlzLnBvczt2YXIgc3RhcnRMb2M9dGhpcy5vcHRpb25zLm9uQ29tbWVudCAmJiB0aGlzLmN1clBvc2l0aW9uKCk7dmFyIGNoPXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArPSBzdGFydFNraXApO3doaWxlKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGggJiYgY2ggIT09IDEwICYmIGNoICE9PSAxMyAmJiBjaCAhPT0gODIzMiAmJiBjaCAhPT0gODIzMykgeysrdGhpcy5wb3M7Y2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO31pZih0aGlzLm9wdGlvbnMub25Db21tZW50KXRoaXMub3B0aW9ucy5vbkNvbW1lbnQoZmFsc2UsdGhpcy5pbnB1dC5zbGljZShzdGFydCArIHN0YXJ0U2tpcCx0aGlzLnBvcyksc3RhcnQsdGhpcy5wb3Msc3RhcnRMb2MsdGhpcy5jdXJQb3NpdGlvbigpKTt9OyAvLyBDYWxsZWQgYXQgdGhlIHN0YXJ0IG9mIHRoZSBwYXJzZSBhbmQgYWZ0ZXIgZXZlcnkgdG9rZW4uIFNraXBzXG4vLyB3aGl0ZXNwYWNlIGFuZCBjb21tZW50cywgYW5kLlxucHAuc2tpcFNwYWNlID0gZnVuY3Rpb24oKXtsb29wOiB3aGlsZSh0aGlzLnBvcyA8IHRoaXMuaW5wdXQubGVuZ3RoKSB7dmFyIGNoPXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7c3dpdGNoKGNoKXtjYXNlIDMyOmNhc2UgMTYwOiAvLyAnICdcbisrdGhpcy5wb3M7YnJlYWs7Y2FzZSAxMzppZih0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKSA9PT0gMTApeysrdGhpcy5wb3M7fWNhc2UgMTA6Y2FzZSA4MjMyOmNhc2UgODIzMzorK3RoaXMucG9zO2lmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpeysrdGhpcy5jdXJMaW5lO3RoaXMubGluZVN0YXJ0ID0gdGhpcy5wb3M7fWJyZWFrO2Nhc2UgNDc6IC8vICcvJ1xuc3dpdGNoKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpKXtjYXNlIDQyOiAvLyAnKidcbnRoaXMuc2tpcEJsb2NrQ29tbWVudCgpO2JyZWFrO2Nhc2UgNDc6dGhpcy5za2lwTGluZUNvbW1lbnQoMik7YnJlYWs7ZGVmYXVsdDpicmVhayBsb29wO31icmVhaztkZWZhdWx0OmlmKGNoID4gOCAmJiBjaCA8IDE0IHx8IGNoID49IDU3NjAgJiYgX3doaXRlc3BhY2Uubm9uQVNDSUl3aGl0ZXNwYWNlLnRlc3QoU3RyaW5nLmZyb21DaGFyQ29kZShjaCkpKXsrK3RoaXMucG9zO31lbHNlIHticmVhayBsb29wO319fX07IC8vIENhbGxlZCBhdCB0aGUgZW5kIG9mIGV2ZXJ5IHRva2VuLiBTZXRzIGBlbmRgLCBgdmFsYCwgYW5kXG4vLyBtYWludGFpbnMgYGNvbnRleHRgIGFuZCBgZXhwckFsbG93ZWRgLCBhbmQgc2tpcHMgdGhlIHNwYWNlIGFmdGVyXG4vLyB0aGUgdG9rZW4sIHNvIHRoYXQgdGhlIG5leHQgb25lJ3MgYHN0YXJ0YCB3aWxsIHBvaW50IGF0IHRoZVxuLy8gcmlnaHQgcG9zaXRpb24uXG5wcC5maW5pc2hUb2tlbiA9IGZ1bmN0aW9uKHR5cGUsdmFsKXt0aGlzLmVuZCA9IHRoaXMucG9zO2lmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpdGhpcy5lbmRMb2MgPSB0aGlzLmN1clBvc2l0aW9uKCk7dmFyIHByZXZUeXBlPXRoaXMudHlwZTt0aGlzLnR5cGUgPSB0eXBlO3RoaXMudmFsdWUgPSB2YWw7dGhpcy51cGRhdGVDb250ZXh0KHByZXZUeXBlKTt9OyAvLyAjIyMgVG9rZW4gcmVhZGluZ1xuLy8gVGhpcyBpcyB0aGUgZnVuY3Rpb24gdGhhdCBpcyBjYWxsZWQgdG8gZmV0Y2ggdGhlIG5leHQgdG9rZW4uIEl0XG4vLyBpcyBzb21ld2hhdCBvYnNjdXJlLCBiZWNhdXNlIGl0IHdvcmtzIGluIGNoYXJhY3RlciBjb2RlcyByYXRoZXJcbi8vIHRoYW4gY2hhcmFjdGVycywgYW5kIGJlY2F1c2Ugb3BlcmF0b3IgcGFyc2luZyBoYXMgYmVlbiBpbmxpbmVkXG4vLyBpbnRvIGl0LlxuLy9cbi8vIEFsbCBpbiB0aGUgbmFtZSBvZiBzcGVlZC5cbi8vXG5wcC5yZWFkVG9rZW5fZG90ID0gZnVuY3Rpb24oKXt2YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZihuZXh0ID49IDQ4ICYmIG5leHQgPD0gNTcpcmV0dXJuIHRoaXMucmVhZE51bWJlcih0cnVlKTt2YXIgbmV4dDI9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMik7aWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgbmV4dCA9PT0gNDYgJiYgbmV4dDIgPT09IDQ2KXsgLy8gNDYgPSBkb3QgJy4nXG50aGlzLnBvcyArPSAzO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuZWxsaXBzaXMpO31lbHNlIHsrK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuZG90KTt9fTtwcC5yZWFkVG9rZW5fc2xhc2ggPSBmdW5jdGlvbigpeyAvLyAnLydcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO2lmKHRoaXMuZXhwckFsbG93ZWQpeysrdGhpcy5wb3M7cmV0dXJuIHRoaXMucmVhZFJlZ2V4cCgpO31pZihuZXh0ID09PSA2MSlyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmFzc2lnbiwyKTtyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLnNsYXNoLDEpO307cHAucmVhZFRva2VuX211bHRfbW9kdWxvID0gZnVuY3Rpb24oY29kZSl7IC8vICclKidcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO2lmKG5leHQgPT09IDYxKXJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLDIpO3JldHVybiB0aGlzLmZpbmlzaE9wKGNvZGUgPT09IDQyP190b2tlbnR5cGUudHlwZXMuc3RhcjpfdG9rZW50eXBlLnR5cGVzLm1vZHVsbywxKTt9O3BwLnJlYWRUb2tlbl9waXBlX2FtcCA9IGZ1bmN0aW9uKGNvZGUpeyAvLyAnfCYnXG52YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAxKTtpZihuZXh0ID09PSBjb2RlKXJldHVybiB0aGlzLmZpbmlzaE9wKGNvZGUgPT09IDEyND9fdG9rZW50eXBlLnR5cGVzLmxvZ2ljYWxPUjpfdG9rZW50eXBlLnR5cGVzLmxvZ2ljYWxBTkQsMik7aWYobmV4dCA9PT0gNjEpcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sMik7cmV0dXJuIHRoaXMuZmluaXNoT3AoY29kZSA9PT0gMTI0P190b2tlbnR5cGUudHlwZXMuYml0d2lzZU9SOl90b2tlbnR5cGUudHlwZXMuYml0d2lzZUFORCwxKTt9O3BwLnJlYWRUb2tlbl9jYXJldCA9IGZ1bmN0aW9uKCl7IC8vICdeJ1xudmFyIG5leHQ9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMSk7aWYobmV4dCA9PT0gNjEpcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sMik7cmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5iaXR3aXNlWE9SLDEpO307cHAucmVhZFRva2VuX3BsdXNfbWluID0gZnVuY3Rpb24oY29kZSl7IC8vICcrLSdcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO2lmKG5leHQgPT09IGNvZGUpe2lmKG5leHQgPT0gNDUgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT0gNjIgJiYgX3doaXRlc3BhY2UubGluZUJyZWFrLnRlc3QodGhpcy5pbnB1dC5zbGljZSh0aGlzLmxhc3RUb2tFbmQsdGhpcy5wb3MpKSl7IC8vIEEgYC0tPmAgbGluZSBjb21tZW50XG50aGlzLnNraXBMaW5lQ29tbWVudCgzKTt0aGlzLnNraXBTcGFjZSgpO3JldHVybiB0aGlzLm5leHRUb2tlbigpO31yZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmluY0RlYywyKTt9aWYobmV4dCA9PT0gNjEpcmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5hc3NpZ24sMik7cmV0dXJuIHRoaXMuZmluaXNoT3AoX3Rva2VudHlwZS50eXBlcy5wbHVzTWluLDEpO307cHAucmVhZFRva2VuX2x0X2d0ID0gZnVuY3Rpb24oY29kZSl7IC8vICc8PidcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO3ZhciBzaXplPTE7aWYobmV4dCA9PT0gY29kZSl7c2l6ZSA9IGNvZGUgPT09IDYyICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDIpID09PSA2Mj8zOjI7aWYodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgc2l6ZSkgPT09IDYxKXJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuYXNzaWduLHNpemUgKyAxKTtyZXR1cm4gdGhpcy5maW5pc2hPcChfdG9rZW50eXBlLnR5cGVzLmJpdFNoaWZ0LHNpemUpO31pZihuZXh0ID09IDMzICYmIGNvZGUgPT0gNjAgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT0gNDUgJiYgdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMykgPT0gNDUpe2lmKHRoaXMuaW5Nb2R1bGUpdGhpcy51bmV4cGVjdGVkKCk7IC8vIGA8IS0tYCwgYW4gWE1MLXN0eWxlIGNvbW1lbnQgdGhhdCBzaG91bGQgYmUgaW50ZXJwcmV0ZWQgYXMgYSBsaW5lIGNvbW1lbnRcbnRoaXMuc2tpcExpbmVDb21tZW50KDQpO3RoaXMuc2tpcFNwYWNlKCk7cmV0dXJuIHRoaXMubmV4dFRva2VuKCk7fWlmKG5leHQgPT09IDYxKXNpemUgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MgKyAyKSA9PT0gNjE/MzoyO3JldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMucmVsYXRpb25hbCxzaXplKTt9O3BwLnJlYWRUb2tlbl9lcV9leGNsID0gZnVuY3Rpb24oY29kZSl7IC8vICc9ISdcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO2lmKG5leHQgPT09IDYxKXJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMuZXF1YWxpdHksdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zICsgMikgPT09IDYxPzM6Mik7aWYoY29kZSA9PT0gNjEgJiYgbmV4dCA9PT0gNjIgJiYgdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpeyAvLyAnPT4nXG50aGlzLnBvcyArPSAyO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYXJyb3cpO31yZXR1cm4gdGhpcy5maW5pc2hPcChjb2RlID09PSA2MT9fdG9rZW50eXBlLnR5cGVzLmVxOl90b2tlbnR5cGUudHlwZXMucHJlZml4LDEpO307cHAuZ2V0VG9rZW5Gcm9tQ29kZSA9IGZ1bmN0aW9uKGNvZGUpe3N3aXRjaChjb2RlKXsgLy8gVGhlIGludGVycHJldGF0aW9uIG9mIGEgZG90IGRlcGVuZHMgb24gd2hldGhlciBpdCBpcyBmb2xsb3dlZFxuLy8gYnkgYSBkaWdpdCBvciBhbm90aGVyIHR3byBkb3RzLlxuY2FzZSA0NjogLy8gJy4nXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fZG90KCk7IC8vIFB1bmN0dWF0aW9uIHRva2Vucy5cbmNhc2UgNDA6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnBhcmVuTCk7Y2FzZSA0MTorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMucGFyZW5SKTtjYXNlIDU5OisrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5zZW1pKTtjYXNlIDQ0OisrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5jb21tYSk7Y2FzZSA5MTorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2tldEwpO2Nhc2UgOTM6Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJyYWNrZXRSKTtjYXNlIDEyMzorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2VMKTtjYXNlIDEyNTorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYnJhY2VSKTtjYXNlIDU4OisrdGhpcy5wb3M7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5jb2xvbik7Y2FzZSA2MzorK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMucXVlc3Rpb24pO2Nhc2UgOTY6IC8vICdgJ1xuaWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uIDwgNilicmVhazsrK3RoaXMucG9zO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuYmFja1F1b3RlKTtjYXNlIDQ4OiAvLyAnMCdcbnZhciBuZXh0PXRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpO2lmKG5leHQgPT09IDEyMCB8fCBuZXh0ID09PSA4OClyZXR1cm4gdGhpcy5yZWFkUmFkaXhOdW1iZXIoMTYpOyAvLyAnMHgnLCAnMFgnIC0gaGV4IG51bWJlclxuaWYodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpe2lmKG5leHQgPT09IDExMSB8fCBuZXh0ID09PSA3OSlyZXR1cm4gdGhpcy5yZWFkUmFkaXhOdW1iZXIoOCk7IC8vICcwbycsICcwTycgLSBvY3RhbCBudW1iZXJcbmlmKG5leHQgPT09IDk4IHx8IG5leHQgPT09IDY2KXJldHVybiB0aGlzLnJlYWRSYWRpeE51bWJlcigyKTsgLy8gJzBiJywgJzBCJyAtIGJpbmFyeSBudW1iZXJcbn0gLy8gQW55dGhpbmcgZWxzZSBiZWdpbm5pbmcgd2l0aCBhIGRpZ2l0IGlzIGFuIGludGVnZXIsIG9jdGFsXG4vLyBudW1iZXIsIG9yIGZsb2F0LlxuY2FzZSA0OTpjYXNlIDUwOmNhc2UgNTE6Y2FzZSA1MjpjYXNlIDUzOmNhc2UgNTQ6Y2FzZSA1NTpjYXNlIDU2OmNhc2UgNTc6IC8vIDEtOVxucmV0dXJuIHRoaXMucmVhZE51bWJlcihmYWxzZSk7IC8vIFF1b3RlcyBwcm9kdWNlIHN0cmluZ3MuXG5jYXNlIDM0OmNhc2UgMzk6IC8vICdcIicsIFwiJ1wiXG5yZXR1cm4gdGhpcy5yZWFkU3RyaW5nKGNvZGUpOyAvLyBPcGVyYXRvcnMgYXJlIHBhcnNlZCBpbmxpbmUgaW4gdGlueSBzdGF0ZSBtYWNoaW5lcy4gJz0nICg2MSkgaXNcbi8vIG9mdGVuIHJlZmVycmVkIHRvLiBgZmluaXNoT3BgIHNpbXBseSBza2lwcyB0aGUgYW1vdW50IG9mXG4vLyBjaGFyYWN0ZXJzIGl0IGlzIGdpdmVuIGFzIHNlY29uZCBhcmd1bWVudCwgYW5kIHJldHVybnMgYSB0b2tlblxuLy8gb2YgdGhlIHR5cGUgZ2l2ZW4gYnkgaXRzIGZpcnN0IGFyZ3VtZW50LlxuY2FzZSA0NzogLy8gJy8nXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fc2xhc2goKTtjYXNlIDM3OmNhc2UgNDI6IC8vICclKidcbnJldHVybiB0aGlzLnJlYWRUb2tlbl9tdWx0X21vZHVsbyhjb2RlKTtjYXNlIDEyNDpjYXNlIDM4OiAvLyAnfCYnXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fcGlwZV9hbXAoY29kZSk7Y2FzZSA5NDogLy8gJ14nXG5yZXR1cm4gdGhpcy5yZWFkVG9rZW5fY2FyZXQoKTtjYXNlIDQzOmNhc2UgNDU6IC8vICcrLSdcbnJldHVybiB0aGlzLnJlYWRUb2tlbl9wbHVzX21pbihjb2RlKTtjYXNlIDYwOmNhc2UgNjI6IC8vICc8PidcbnJldHVybiB0aGlzLnJlYWRUb2tlbl9sdF9ndChjb2RlKTtjYXNlIDYxOmNhc2UgMzM6IC8vICc9ISdcbnJldHVybiB0aGlzLnJlYWRUb2tlbl9lcV9leGNsKGNvZGUpO2Nhc2UgMTI2OiAvLyAnfidcbnJldHVybiB0aGlzLmZpbmlzaE9wKF90b2tlbnR5cGUudHlwZXMucHJlZml4LDEpO310aGlzLnJhaXNlKHRoaXMucG9zLFwiVW5leHBlY3RlZCBjaGFyYWN0ZXIgJ1wiICsgY29kZVBvaW50VG9TdHJpbmcoY29kZSkgKyBcIidcIik7fTtwcC5maW5pc2hPcCA9IGZ1bmN0aW9uKHR5cGUsc2l6ZSl7dmFyIHN0cj10aGlzLmlucHV0LnNsaWNlKHRoaXMucG9zLHRoaXMucG9zICsgc2l6ZSk7dGhpcy5wb3MgKz0gc2l6ZTtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbih0eXBlLHN0cik7fTsgLy8gUGFyc2UgYSByZWd1bGFyIGV4cHJlc3Npb24uIFNvbWUgY29udGV4dC1hd2FyZW5lc3MgaXMgbmVjZXNzYXJ5LFxuLy8gc2luY2UgYSAnLycgaW5zaWRlIGEgJ1tdJyBzZXQgZG9lcyBub3QgZW5kIHRoZSBleHByZXNzaW9uLlxuZnVuY3Rpb24gdHJ5Q3JlYXRlUmVnZXhwKHNyYyxmbGFncyx0aHJvd0Vycm9yQXQpe3RyeXtyZXR1cm4gbmV3IFJlZ0V4cChzcmMsZmxhZ3MpO31jYXRjaChlKSB7aWYodGhyb3dFcnJvckF0ICE9PSB1bmRlZmluZWQpe2lmKGUgaW5zdGFuY2VvZiBTeW50YXhFcnJvcil0aGlzLnJhaXNlKHRocm93RXJyb3JBdCxcIkVycm9yIHBhcnNpbmcgcmVndWxhciBleHByZXNzaW9uOiBcIiArIGUubWVzc2FnZSk7dGhpcy5yYWlzZShlKTt9fX12YXIgcmVnZXhwVW5pY29kZVN1cHBvcnQ9ISF0cnlDcmVhdGVSZWdleHAoXCLvv79cIixcInVcIik7cHAucmVhZFJlZ2V4cCA9IGZ1bmN0aW9uKCl7dmFyIF90aGlzPXRoaXM7dmFyIGVzY2FwZWQ9dW5kZWZpbmVkLGluQ2xhc3M9dW5kZWZpbmVkLHN0YXJ0PXRoaXMucG9zO2Zvcig7Oykge2lmKHRoaXMucG9zID49IHRoaXMuaW5wdXQubGVuZ3RoKXRoaXMucmFpc2Uoc3RhcnQsXCJVbnRlcm1pbmF0ZWQgcmVndWxhciBleHByZXNzaW9uXCIpO3ZhciBjaD10aGlzLmlucHV0LmNoYXJBdCh0aGlzLnBvcyk7aWYoX3doaXRlc3BhY2UubGluZUJyZWFrLnRlc3QoY2gpKXRoaXMucmFpc2Uoc3RhcnQsXCJVbnRlcm1pbmF0ZWQgcmVndWxhciBleHByZXNzaW9uXCIpO2lmKCFlc2NhcGVkKXtpZihjaCA9PT0gXCJbXCIpaW5DbGFzcyA9IHRydWU7ZWxzZSBpZihjaCA9PT0gXCJdXCIgJiYgaW5DbGFzcylpbkNsYXNzID0gZmFsc2U7ZWxzZSBpZihjaCA9PT0gXCIvXCIgJiYgIWluQ2xhc3MpYnJlYWs7ZXNjYXBlZCA9IGNoID09PSBcIlxcXFxcIjt9ZWxzZSBlc2NhcGVkID0gZmFsc2U7Kyt0aGlzLnBvczt9dmFyIGNvbnRlbnQ9dGhpcy5pbnB1dC5zbGljZShzdGFydCx0aGlzLnBvcyk7Kyt0aGlzLnBvczsgLy8gTmVlZCB0byB1c2UgYHJlYWRXb3JkMWAgYmVjYXVzZSAnXFx1WFhYWCcgc2VxdWVuY2VzIGFyZSBhbGxvd2VkXG4vLyBoZXJlIChkb24ndCBhc2spLlxudmFyIG1vZHM9dGhpcy5yZWFkV29yZDEoKTt2YXIgdG1wPWNvbnRlbnQ7aWYobW9kcyl7dmFyIHZhbGlkRmxhZ3M9L15bZ21zaXldKiQvO2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KXZhbGlkRmxhZ3MgPSAvXltnbXNpeXVdKiQvO2lmKCF2YWxpZEZsYWdzLnRlc3QobW9kcykpdGhpcy5yYWlzZShzdGFydCxcIkludmFsaWQgcmVndWxhciBleHByZXNzaW9uIGZsYWdcIik7aWYobW9kcy5pbmRleE9mKCd1JykgPj0gMCAmJiAhcmVnZXhwVW5pY29kZVN1cHBvcnQpeyAvLyBSZXBsYWNlIGVhY2ggYXN0cmFsIHN5bWJvbCBhbmQgZXZlcnkgVW5pY29kZSBlc2NhcGUgc2VxdWVuY2UgdGhhdFxuLy8gcG9zc2libHkgcmVwcmVzZW50cyBhbiBhc3RyYWwgc3ltYm9sIG9yIGEgcGFpcmVkIHN1cnJvZ2F0ZSB3aXRoIGFcbi8vIHNpbmdsZSBBU0NJSSBzeW1ib2wgdG8gYXZvaWQgdGhyb3dpbmcgb24gcmVndWxhciBleHByZXNzaW9ucyB0aGF0XG4vLyBhcmUgb25seSB2YWxpZCBpbiBjb21iaW5hdGlvbiB3aXRoIHRoZSBgL3VgIGZsYWcuXG4vLyBOb3RlOiByZXBsYWNpbmcgd2l0aCB0aGUgQVNDSUkgc3ltYm9sIGB4YCBtaWdodCBjYXVzZSBmYWxzZVxuLy8gbmVnYXRpdmVzIGluIHVubGlrZWx5IHNjZW5hcmlvcy4gRm9yIGV4YW1wbGUsIGBbXFx1ezYxfS1iXWAgaXMgYVxuLy8gcGVyZmVjdGx5IHZhbGlkIHBhdHRlcm4gdGhhdCBpcyBlcXVpdmFsZW50IHRvIGBbYS1iXWAsIGJ1dCBpdCB3b3VsZFxuLy8gYmUgcmVwbGFjZWQgYnkgYFt4LWJdYCB3aGljaCB0aHJvd3MgYW4gZXJyb3IuXG50bXAgPSB0bXAucmVwbGFjZSgvXFxcXHVcXHsoWzAtOWEtZkEtRl0rKVxcfS9nLGZ1bmN0aW9uKG1hdGNoLGNvZGUsb2Zmc2V0KXtjb2RlID0gTnVtYmVyKFwiMHhcIiArIGNvZGUpO2lmKGNvZGUgPiAweDEwRkZGRilfdGhpcy5yYWlzZShzdGFydCArIG9mZnNldCArIDMsXCJDb2RlIHBvaW50IG91dCBvZiBib3VuZHNcIik7cmV0dXJuIFwieFwiO30pO3RtcCA9IHRtcC5yZXBsYWNlKC9cXFxcdShbYS1mQS1GMC05XXs0fSl8W1xcdUQ4MDAtXFx1REJGRl1bXFx1REMwMC1cXHVERkZGXS9nLFwieFwiKTt9fSAvLyBEZXRlY3QgaW52YWxpZCByZWd1bGFyIGV4cHJlc3Npb25zLlxudmFyIHZhbHVlPW51bGw7IC8vIFJoaW5vJ3MgcmVndWxhciBleHByZXNzaW9uIHBhcnNlciBpcyBmbGFreSBhbmQgdGhyb3dzIHVuY2F0Y2hhYmxlIGV4Y2VwdGlvbnMsXG4vLyBzbyBkb24ndCBkbyBkZXRlY3Rpb24gaWYgd2UgYXJlIHJ1bm5pbmcgdW5kZXIgUmhpbm9cbmlmKCFpc1JoaW5vKXt0cnlDcmVhdGVSZWdleHAodG1wLHVuZGVmaW5lZCxzdGFydCk7IC8vIEdldCBhIHJlZ3VsYXIgZXhwcmVzc2lvbiBvYmplY3QgZm9yIHRoaXMgcGF0dGVybi1mbGFnIHBhaXIsIG9yIGBudWxsYCBpblxuLy8gY2FzZSB0aGUgY3VycmVudCBlbnZpcm9ubWVudCBkb2Vzbid0IHN1cHBvcnQgdGhlIGZsYWdzIGl0IHVzZXMuXG52YWx1ZSA9IHRyeUNyZWF0ZVJlZ2V4cChjb250ZW50LG1vZHMpO31yZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnJlZ2V4cCx7cGF0dGVybjpjb250ZW50LGZsYWdzOm1vZHMsdmFsdWU6dmFsdWV9KTt9OyAvLyBSZWFkIGFuIGludGVnZXIgaW4gdGhlIGdpdmVuIHJhZGl4LiBSZXR1cm4gbnVsbCBpZiB6ZXJvIGRpZ2l0c1xuLy8gd2VyZSByZWFkLCB0aGUgaW50ZWdlciB2YWx1ZSBvdGhlcndpc2UuIFdoZW4gYGxlbmAgaXMgZ2l2ZW4sIHRoaXNcbi8vIHdpbGwgcmV0dXJuIGBudWxsYCB1bmxlc3MgdGhlIGludGVnZXIgaGFzIGV4YWN0bHkgYGxlbmAgZGlnaXRzLlxucHAucmVhZEludCA9IGZ1bmN0aW9uKHJhZGl4LGxlbil7dmFyIHN0YXJ0PXRoaXMucG9zLHRvdGFsPTA7Zm9yKHZhciBpPTAsZT1sZW4gPT0gbnVsbD9JbmZpbml0eTpsZW47aSA8IGU7KytpKSB7dmFyIGNvZGU9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSx2YWw9dW5kZWZpbmVkO2lmKGNvZGUgPj0gOTcpdmFsID0gY29kZSAtIDk3ICsgMTA7IC8vIGFcbmVsc2UgaWYoY29kZSA+PSA2NSl2YWwgPSBjb2RlIC0gNjUgKyAxMDsgLy8gQVxuZWxzZSBpZihjb2RlID49IDQ4ICYmIGNvZGUgPD0gNTcpdmFsID0gY29kZSAtIDQ4OyAvLyAwLTlcbmVsc2UgdmFsID0gSW5maW5pdHk7aWYodmFsID49IHJhZGl4KWJyZWFrOysrdGhpcy5wb3M7dG90YWwgPSB0b3RhbCAqIHJhZGl4ICsgdmFsO31pZih0aGlzLnBvcyA9PT0gc3RhcnQgfHwgbGVuICE9IG51bGwgJiYgdGhpcy5wb3MgLSBzdGFydCAhPT0gbGVuKXJldHVybiBudWxsO3JldHVybiB0b3RhbDt9O3BwLnJlYWRSYWRpeE51bWJlciA9IGZ1bmN0aW9uKHJhZGl4KXt0aGlzLnBvcyArPSAyOyAvLyAweFxudmFyIHZhbD10aGlzLnJlYWRJbnQocmFkaXgpO2lmKHZhbCA9PSBudWxsKXRoaXMucmFpc2UodGhpcy5zdGFydCArIDIsXCJFeHBlY3RlZCBudW1iZXIgaW4gcmFkaXggXCIgKyByYWRpeCk7aWYoX2lkZW50aWZpZXIuaXNJZGVudGlmaWVyU3RhcnQodGhpcy5mdWxsQ2hhckNvZGVBdFBvcygpKSl0aGlzLnJhaXNlKHRoaXMucG9zLFwiSWRlbnRpZmllciBkaXJlY3RseSBhZnRlciBudW1iZXJcIik7cmV0dXJuIHRoaXMuZmluaXNoVG9rZW4oX3Rva2VudHlwZS50eXBlcy5udW0sdmFsKTt9OyAvLyBSZWFkIGFuIGludGVnZXIsIG9jdGFsIGludGVnZXIsIG9yIGZsb2F0aW5nLXBvaW50IG51bWJlci5cbnBwLnJlYWROdW1iZXIgPSBmdW5jdGlvbihzdGFydHNXaXRoRG90KXt2YXIgc3RhcnQ9dGhpcy5wb3MsaXNGbG9hdD1mYWxzZSxvY3RhbD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpID09PSA0ODtpZighc3RhcnRzV2l0aERvdCAmJiB0aGlzLnJlYWRJbnQoMTApID09PSBudWxsKXRoaXMucmFpc2Uoc3RhcnQsXCJJbnZhbGlkIG51bWJlclwiKTt2YXIgbmV4dD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO2lmKG5leHQgPT09IDQ2KXsgLy8gJy4nXG4rK3RoaXMucG9zO3RoaXMucmVhZEludCgxMCk7aXNGbG9hdCA9IHRydWU7bmV4dCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyk7fWlmKG5leHQgPT09IDY5IHx8IG5leHQgPT09IDEwMSl7IC8vICdlRSdcbm5leHQgPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQoKyt0aGlzLnBvcyk7aWYobmV4dCA9PT0gNDMgfHwgbmV4dCA9PT0gNDUpKyt0aGlzLnBvczsgLy8gJystJ1xuaWYodGhpcy5yZWFkSW50KDEwKSA9PT0gbnVsbCl0aGlzLnJhaXNlKHN0YXJ0LFwiSW52YWxpZCBudW1iZXJcIik7aXNGbG9hdCA9IHRydWU7fWlmKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0KHRoaXMuZnVsbENoYXJDb2RlQXRQb3MoKSkpdGhpcy5yYWlzZSh0aGlzLnBvcyxcIklkZW50aWZpZXIgZGlyZWN0bHkgYWZ0ZXIgbnVtYmVyXCIpO3ZhciBzdHI9dGhpcy5pbnB1dC5zbGljZShzdGFydCx0aGlzLnBvcyksdmFsPXVuZGVmaW5lZDtpZihpc0Zsb2F0KXZhbCA9IHBhcnNlRmxvYXQoc3RyKTtlbHNlIGlmKCFvY3RhbCB8fCBzdHIubGVuZ3RoID09PSAxKXZhbCA9IHBhcnNlSW50KHN0ciwxMCk7ZWxzZSBpZigvWzg5XS8udGVzdChzdHIpIHx8IHRoaXMuc3RyaWN0KXRoaXMucmFpc2Uoc3RhcnQsXCJJbnZhbGlkIG51bWJlclwiKTtlbHNlIHZhbCA9IHBhcnNlSW50KHN0ciw4KTtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLm51bSx2YWwpO307IC8vIFJlYWQgYSBzdHJpbmcgdmFsdWUsIGludGVycHJldGluZyBiYWNrc2xhc2gtZXNjYXBlcy5cbnBwLnJlYWRDb2RlUG9pbnQgPSBmdW5jdGlvbigpe3ZhciBjaD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpLGNvZGU9dW5kZWZpbmVkO2lmKGNoID09PSAxMjMpe2lmKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA8IDYpdGhpcy51bmV4cGVjdGVkKCk7dmFyIGNvZGVQb3M9Kyt0aGlzLnBvcztjb2RlID0gdGhpcy5yZWFkSGV4Q2hhcih0aGlzLmlucHV0LmluZGV4T2YoJ30nLHRoaXMucG9zKSAtIHRoaXMucG9zKTsrK3RoaXMucG9zO2lmKGNvZGUgPiAweDEwRkZGRil0aGlzLnJhaXNlKGNvZGVQb3MsXCJDb2RlIHBvaW50IG91dCBvZiBib3VuZHNcIik7fWVsc2Uge2NvZGUgPSB0aGlzLnJlYWRIZXhDaGFyKDQpO31yZXR1cm4gY29kZTt9O2Z1bmN0aW9uIGNvZGVQb2ludFRvU3RyaW5nKGNvZGUpeyAvLyBVVEYtMTYgRGVjb2RpbmdcbmlmKGNvZGUgPD0gMHhGRkZGKXJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpO2NvZGUgLT0gMHgxMDAwMDtyZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZSgoY29kZSA+PiAxMCkgKyAweEQ4MDAsKGNvZGUgJiAxMDIzKSArIDB4REMwMCk7fXBwLnJlYWRTdHJpbmcgPSBmdW5jdGlvbihxdW90ZSl7dmFyIG91dD1cIlwiLGNodW5rU3RhcnQ9Kyt0aGlzLnBvcztmb3IoOzspIHtpZih0aGlzLnBvcyA+PSB0aGlzLmlucHV0Lmxlbmd0aCl0aGlzLnJhaXNlKHRoaXMuc3RhcnQsXCJVbnRlcm1pbmF0ZWQgc3RyaW5nIGNvbnN0YW50XCIpO3ZhciBjaD10aGlzLmlucHV0LmNoYXJDb2RlQXQodGhpcy5wb3MpO2lmKGNoID09PSBxdW90ZSlicmVhaztpZihjaCA9PT0gOTIpeyAvLyAnXFwnXG5vdXQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LHRoaXMucG9zKTtvdXQgKz0gdGhpcy5yZWFkRXNjYXBlZENoYXIoZmFsc2UpO2NodW5rU3RhcnQgPSB0aGlzLnBvczt9ZWxzZSB7aWYoX3doaXRlc3BhY2UuaXNOZXdMaW5lKGNoKSl0aGlzLnJhaXNlKHRoaXMuc3RhcnQsXCJVbnRlcm1pbmF0ZWQgc3RyaW5nIGNvbnN0YW50XCIpOysrdGhpcy5wb3M7fX1vdXQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LHRoaXMucG9zKyspO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuc3RyaW5nLG91dCk7fTsgLy8gUmVhZHMgdGVtcGxhdGUgc3RyaW5nIHRva2Vucy5cbnBwLnJlYWRUbXBsVG9rZW4gPSBmdW5jdGlvbigpe3ZhciBvdXQ9XCJcIixjaHVua1N0YXJ0PXRoaXMucG9zO2Zvcig7Oykge2lmKHRoaXMucG9zID49IHRoaXMuaW5wdXQubGVuZ3RoKXRoaXMucmFpc2UodGhpcy5zdGFydCxcIlVudGVybWluYXRlZCB0ZW1wbGF0ZVwiKTt2YXIgY2g9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKTtpZihjaCA9PT0gOTYgfHwgY2ggPT09IDM2ICYmIHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcyArIDEpID09PSAxMjMpeyAvLyAnYCcsICckeydcbmlmKHRoaXMucG9zID09PSB0aGlzLnN0YXJ0ICYmIHRoaXMudHlwZSA9PT0gX3Rva2VudHlwZS50eXBlcy50ZW1wbGF0ZSl7aWYoY2ggPT09IDM2KXt0aGlzLnBvcyArPSAyO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKF90b2tlbnR5cGUudHlwZXMuZG9sbGFyQnJhY2VMKTt9ZWxzZSB7Kyt0aGlzLnBvcztyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLmJhY2tRdW90ZSk7fX1vdXQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LHRoaXMucG9zKTtyZXR1cm4gdGhpcy5maW5pc2hUb2tlbihfdG9rZW50eXBlLnR5cGVzLnRlbXBsYXRlLG91dCk7fWlmKGNoID09PSA5Mil7IC8vICdcXCdcbm91dCArPSB0aGlzLmlucHV0LnNsaWNlKGNodW5rU3RhcnQsdGhpcy5wb3MpO291dCArPSB0aGlzLnJlYWRFc2NhcGVkQ2hhcih0cnVlKTtjaHVua1N0YXJ0ID0gdGhpcy5wb3M7fWVsc2UgaWYoX3doaXRlc3BhY2UuaXNOZXdMaW5lKGNoKSl7b3V0ICs9IHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCx0aGlzLnBvcyk7Kyt0aGlzLnBvcztzd2l0Y2goY2gpe2Nhc2UgMTM6aWYodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHRoaXMucG9zKSA9PT0gMTApKyt0aGlzLnBvcztjYXNlIDEwOm91dCArPSBcIlxcblwiO2JyZWFrO2RlZmF1bHQ6b3V0ICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoY2gpO2JyZWFrO31pZih0aGlzLm9wdGlvbnMubG9jYXRpb25zKXsrK3RoaXMuY3VyTGluZTt0aGlzLmxpbmVTdGFydCA9IHRoaXMucG9zO31jaHVua1N0YXJ0ID0gdGhpcy5wb3M7fWVsc2UgeysrdGhpcy5wb3M7fX19OyAvLyBVc2VkIHRvIHJlYWQgZXNjYXBlZCBjaGFyYWN0ZXJzXG5wcC5yZWFkRXNjYXBlZENoYXIgPSBmdW5jdGlvbihpblRlbXBsYXRlKXt2YXIgY2g9dGhpcy5pbnB1dC5jaGFyQ29kZUF0KCsrdGhpcy5wb3MpOysrdGhpcy5wb3M7c3dpdGNoKGNoKXtjYXNlIDExMDpyZXR1cm4gXCJcXG5cIjsgLy8gJ24nIC0+ICdcXG4nXG5jYXNlIDExNDpyZXR1cm4gXCJcXHJcIjsgLy8gJ3InIC0+ICdcXHInXG5jYXNlIDEyMDpyZXR1cm4gU3RyaW5nLmZyb21DaGFyQ29kZSh0aGlzLnJlYWRIZXhDaGFyKDIpKTsgLy8gJ3gnXG5jYXNlIDExNzpyZXR1cm4gY29kZVBvaW50VG9TdHJpbmcodGhpcy5yZWFkQ29kZVBvaW50KCkpOyAvLyAndSdcbmNhc2UgMTE2OnJldHVybiBcIlxcdFwiOyAvLyAndCcgLT4gJ1xcdCdcbmNhc2UgOTg6cmV0dXJuIFwiXFxiXCI7IC8vICdiJyAtPiAnXFxiJ1xuY2FzZSAxMTg6cmV0dXJuIFwiXFx1MDAwYlwiOyAvLyAndicgLT4gJ1xcdTAwMGInXG5jYXNlIDEwMjpyZXR1cm4gXCJcXGZcIjsgLy8gJ2YnIC0+ICdcXGYnXG5jYXNlIDEzOmlmKHRoaXMuaW5wdXQuY2hhckNvZGVBdCh0aGlzLnBvcykgPT09IDEwKSsrdGhpcy5wb3M7IC8vICdcXHJcXG4nXG5jYXNlIDEwOiAvLyAnIFxcbidcbmlmKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpe3RoaXMubGluZVN0YXJ0ID0gdGhpcy5wb3M7Kyt0aGlzLmN1ckxpbmU7fXJldHVybiBcIlwiO2RlZmF1bHQ6aWYoY2ggPj0gNDggJiYgY2ggPD0gNTUpe3ZhciBvY3RhbFN0cj10aGlzLmlucHV0LnN1YnN0cih0aGlzLnBvcyAtIDEsMykubWF0Y2goL15bMC03XSsvKVswXTt2YXIgb2N0YWw9cGFyc2VJbnQob2N0YWxTdHIsOCk7aWYob2N0YWwgPiAyNTUpe29jdGFsU3RyID0gb2N0YWxTdHIuc2xpY2UoMCwtMSk7b2N0YWwgPSBwYXJzZUludChvY3RhbFN0ciw4KTt9aWYob2N0YWwgPiAwICYmICh0aGlzLnN0cmljdCB8fCBpblRlbXBsYXRlKSl7dGhpcy5yYWlzZSh0aGlzLnBvcyAtIDIsXCJPY3RhbCBsaXRlcmFsIGluIHN0cmljdCBtb2RlXCIpO310aGlzLnBvcyArPSBvY3RhbFN0ci5sZW5ndGggLSAxO3JldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKG9jdGFsKTt9cmV0dXJuIFN0cmluZy5mcm9tQ2hhckNvZGUoY2gpO319OyAvLyBVc2VkIHRvIHJlYWQgY2hhcmFjdGVyIGVzY2FwZSBzZXF1ZW5jZXMgKCdcXHgnLCAnXFx1JywgJ1xcVScpLlxucHAucmVhZEhleENoYXIgPSBmdW5jdGlvbihsZW4pe3ZhciBjb2RlUG9zPXRoaXMucG9zO3ZhciBuPXRoaXMucmVhZEludCgxNixsZW4pO2lmKG4gPT09IG51bGwpdGhpcy5yYWlzZShjb2RlUG9zLFwiQmFkIGNoYXJhY3RlciBlc2NhcGUgc2VxdWVuY2VcIik7cmV0dXJuIG47fTsgLy8gUmVhZCBhbiBpZGVudGlmaWVyLCBhbmQgcmV0dXJuIGl0IGFzIGEgc3RyaW5nLiBTZXRzIGB0aGlzLmNvbnRhaW5zRXNjYFxuLy8gdG8gd2hldGhlciB0aGUgd29yZCBjb250YWluZWQgYSAnXFx1JyBlc2NhcGUuXG4vL1xuLy8gSW5jcmVtZW50YWxseSBhZGRzIG9ubHkgZXNjYXBlZCBjaGFycywgYWRkaW5nIG90aGVyIGNodW5rcyBhcy1pc1xuLy8gYXMgYSBtaWNyby1vcHRpbWl6YXRpb24uXG5wcC5yZWFkV29yZDEgPSBmdW5jdGlvbigpe3RoaXMuY29udGFpbnNFc2MgPSBmYWxzZTt2YXIgd29yZD1cIlwiLGZpcnN0PXRydWUsY2h1bmtTdGFydD10aGlzLnBvczt2YXIgYXN0cmFsPXRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2O3doaWxlKHRoaXMucG9zIDwgdGhpcy5pbnB1dC5sZW5ndGgpIHt2YXIgY2g9dGhpcy5mdWxsQ2hhckNvZGVBdFBvcygpO2lmKF9pZGVudGlmaWVyLmlzSWRlbnRpZmllckNoYXIoY2gsYXN0cmFsKSl7dGhpcy5wb3MgKz0gY2ggPD0gMHhmZmZmPzE6Mjt9ZWxzZSBpZihjaCA9PT0gOTIpeyAvLyBcIlxcXCJcbnRoaXMuY29udGFpbnNFc2MgPSB0cnVlO3dvcmQgKz0gdGhpcy5pbnB1dC5zbGljZShjaHVua1N0YXJ0LHRoaXMucG9zKTt2YXIgZXNjU3RhcnQ9dGhpcy5wb3M7aWYodGhpcy5pbnB1dC5jaGFyQ29kZUF0KCsrdGhpcy5wb3MpICE9IDExNykgLy8gXCJ1XCJcbnRoaXMucmFpc2UodGhpcy5wb3MsXCJFeHBlY3RpbmcgVW5pY29kZSBlc2NhcGUgc2VxdWVuY2UgXFxcXHVYWFhYXCIpOysrdGhpcy5wb3M7dmFyIGVzYz10aGlzLnJlYWRDb2RlUG9pbnQoKTtpZighKGZpcnN0P19pZGVudGlmaWVyLmlzSWRlbnRpZmllclN0YXJ0Ol9pZGVudGlmaWVyLmlzSWRlbnRpZmllckNoYXIpKGVzYyxhc3RyYWwpKXRoaXMucmFpc2UoZXNjU3RhcnQsXCJJbnZhbGlkIFVuaWNvZGUgZXNjYXBlXCIpO3dvcmQgKz0gY29kZVBvaW50VG9TdHJpbmcoZXNjKTtjaHVua1N0YXJ0ID0gdGhpcy5wb3M7fWVsc2Uge2JyZWFrO31maXJzdCA9IGZhbHNlO31yZXR1cm4gd29yZCArIHRoaXMuaW5wdXQuc2xpY2UoY2h1bmtTdGFydCx0aGlzLnBvcyk7fTsgLy8gUmVhZCBhbiBpZGVudGlmaWVyIG9yIGtleXdvcmQgdG9rZW4uIFdpbGwgY2hlY2sgZm9yIHJlc2VydmVkXG4vLyB3b3JkcyB3aGVuIG5lY2Vzc2FyeS5cbnBwLnJlYWRXb3JkID0gZnVuY3Rpb24oKXt2YXIgd29yZD10aGlzLnJlYWRXb3JkMSgpO3ZhciB0eXBlPV90b2tlbnR5cGUudHlwZXMubmFtZTtpZigodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgfHwgIXRoaXMuY29udGFpbnNFc2MpICYmIHRoaXMuaXNLZXl3b3JkKHdvcmQpKXR5cGUgPSBfdG9rZW50eXBlLmtleXdvcmRzW3dvcmRdO3JldHVybiB0aGlzLmZpbmlzaFRva2VuKHR5cGUsd29yZCk7fTt9LHtcIi4vaWRlbnRpZmllclwiOjIsXCIuL2xvY3V0aWxcIjo1LFwiLi9zdGF0ZVwiOjEwLFwiLi90b2tlbnR5cGVcIjoxNCxcIi4vd2hpdGVzcGFjZVwiOjE2fV0sMTQ6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpeyAvLyAjIyBUb2tlbiB0eXBlc1xuLy8gVGhlIGFzc2lnbm1lbnQgb2YgZmluZS1ncmFpbmVkLCBpbmZvcm1hdGlvbi1jYXJyeWluZyB0eXBlIG9iamVjdHNcbi8vIGFsbG93cyB0aGUgdG9rZW5pemVyIHRvIHN0b3JlIHRoZSBpbmZvcm1hdGlvbiBpdCBoYXMgYWJvdXQgYVxuLy8gdG9rZW4gaW4gYSB3YXkgdGhhdCBpcyB2ZXJ5IGNoZWFwIGZvciB0aGUgcGFyc2VyIHRvIGxvb2sgdXAuXG4vLyBBbGwgdG9rZW4gdHlwZSB2YXJpYWJsZXMgc3RhcnQgd2l0aCBhbiB1bmRlcnNjb3JlLCB0byBtYWtlIHRoZW1cbi8vIGVhc3kgdG8gcmVjb2duaXplLlxuLy8gVGhlIGBiZWZvcmVFeHByYCBwcm9wZXJ0eSBpcyB1c2VkIHRvIGRpc2FtYmlndWF0ZSBiZXR3ZWVuIHJlZ3VsYXJcbi8vIGV4cHJlc3Npb25zIGFuZCBkaXZpc2lvbnMuIEl0IGlzIHNldCBvbiBhbGwgdG9rZW4gdHlwZXMgdGhhdCBjYW5cbi8vIGJlIGZvbGxvd2VkIGJ5IGFuIGV4cHJlc3Npb24gKHRodXMsIGEgc2xhc2ggYWZ0ZXIgdGhlbSB3b3VsZCBiZSBhXG4vLyByZWd1bGFyIGV4cHJlc3Npb24pLlxuLy9cbi8vIGBpc0xvb3BgIG1hcmtzIGEga2V5d29yZCBhcyBzdGFydGluZyBhIGxvb3AsIHdoaWNoIGlzIGltcG9ydGFudFxuLy8gdG8ga25vdyB3aGVuIHBhcnNpbmcgYSBsYWJlbCwgaW4gb3JkZXIgdG8gYWxsb3cgb3IgZGlzYWxsb3dcbi8vIGNvbnRpbnVlIGp1bXBzIHRvIHRoYXQgbGFiZWwuXG5cInVzZSBzdHJpY3RcIjtleHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO2Z1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSxDb25zdHJ1Y3Rvcil7aWYoIShpbnN0YW5jZSBpbnN0YW5jZW9mIENvbnN0cnVjdG9yKSl7dGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTt9fXZhciBUb2tlblR5cGU9ZnVuY3Rpb24gVG9rZW5UeXBlKGxhYmVsKXt2YXIgY29uZj1hcmd1bWVudHMubGVuZ3RoIDw9IDEgfHwgYXJndW1lbnRzWzFdID09PSB1bmRlZmluZWQ/e306YXJndW1lbnRzWzFdO19jbGFzc0NhbGxDaGVjayh0aGlzLFRva2VuVHlwZSk7dGhpcy5sYWJlbCA9IGxhYmVsO3RoaXMua2V5d29yZCA9IGNvbmYua2V5d29yZDt0aGlzLmJlZm9yZUV4cHIgPSAhIWNvbmYuYmVmb3JlRXhwcjt0aGlzLnN0YXJ0c0V4cHIgPSAhIWNvbmYuc3RhcnRzRXhwcjt0aGlzLmlzTG9vcCA9ICEhY29uZi5pc0xvb3A7dGhpcy5pc0Fzc2lnbiA9ICEhY29uZi5pc0Fzc2lnbjt0aGlzLnByZWZpeCA9ICEhY29uZi5wcmVmaXg7dGhpcy5wb3N0Zml4ID0gISFjb25mLnBvc3RmaXg7dGhpcy5iaW5vcCA9IGNvbmYuYmlub3AgfHwgbnVsbDt0aGlzLnVwZGF0ZUNvbnRleHQgPSBudWxsO307ZXhwb3J0cy5Ub2tlblR5cGUgPSBUb2tlblR5cGU7ZnVuY3Rpb24gYmlub3AobmFtZSxwcmVjKXtyZXR1cm4gbmV3IFRva2VuVHlwZShuYW1lLHtiZWZvcmVFeHByOnRydWUsYmlub3A6cHJlY30pO312YXIgYmVmb3JlRXhwcj17YmVmb3JlRXhwcjp0cnVlfSxzdGFydHNFeHByPXtzdGFydHNFeHByOnRydWV9O3ZhciB0eXBlcz17bnVtOm5ldyBUb2tlblR5cGUoXCJudW1cIixzdGFydHNFeHByKSxyZWdleHA6bmV3IFRva2VuVHlwZShcInJlZ2V4cFwiLHN0YXJ0c0V4cHIpLHN0cmluZzpuZXcgVG9rZW5UeXBlKFwic3RyaW5nXCIsc3RhcnRzRXhwciksbmFtZTpuZXcgVG9rZW5UeXBlKFwibmFtZVwiLHN0YXJ0c0V4cHIpLGVvZjpuZXcgVG9rZW5UeXBlKFwiZW9mXCIpLCAvLyBQdW5jdHVhdGlvbiB0b2tlbiB0eXBlcy5cbmJyYWNrZXRMOm5ldyBUb2tlblR5cGUoXCJbXCIse2JlZm9yZUV4cHI6dHJ1ZSxzdGFydHNFeHByOnRydWV9KSxicmFja2V0UjpuZXcgVG9rZW5UeXBlKFwiXVwiKSxicmFjZUw6bmV3IFRva2VuVHlwZShcIntcIix7YmVmb3JlRXhwcjp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pLGJyYWNlUjpuZXcgVG9rZW5UeXBlKFwifVwiKSxwYXJlbkw6bmV3IFRva2VuVHlwZShcIihcIix7YmVmb3JlRXhwcjp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pLHBhcmVuUjpuZXcgVG9rZW5UeXBlKFwiKVwiKSxjb21tYTpuZXcgVG9rZW5UeXBlKFwiLFwiLGJlZm9yZUV4cHIpLHNlbWk6bmV3IFRva2VuVHlwZShcIjtcIixiZWZvcmVFeHByKSxjb2xvbjpuZXcgVG9rZW5UeXBlKFwiOlwiLGJlZm9yZUV4cHIpLGRvdDpuZXcgVG9rZW5UeXBlKFwiLlwiKSxxdWVzdGlvbjpuZXcgVG9rZW5UeXBlKFwiP1wiLGJlZm9yZUV4cHIpLGFycm93Om5ldyBUb2tlblR5cGUoXCI9PlwiLGJlZm9yZUV4cHIpLHRlbXBsYXRlOm5ldyBUb2tlblR5cGUoXCJ0ZW1wbGF0ZVwiKSxlbGxpcHNpczpuZXcgVG9rZW5UeXBlKFwiLi4uXCIsYmVmb3JlRXhwciksYmFja1F1b3RlOm5ldyBUb2tlblR5cGUoXCJgXCIsc3RhcnRzRXhwciksZG9sbGFyQnJhY2VMOm5ldyBUb2tlblR5cGUoXCIke1wiLHtiZWZvcmVFeHByOnRydWUsc3RhcnRzRXhwcjp0cnVlfSksIC8vIE9wZXJhdG9ycy4gVGhlc2UgY2Fycnkgc2V2ZXJhbCBraW5kcyBvZiBwcm9wZXJ0aWVzIHRvIGhlbHAgdGhlXG4vLyBwYXJzZXIgdXNlIHRoZW0gcHJvcGVybHkgKHRoZSBwcmVzZW5jZSBvZiB0aGVzZSBwcm9wZXJ0aWVzIGlzXG4vLyB3aGF0IGNhdGVnb3JpemVzIHRoZW0gYXMgb3BlcmF0b3JzKS5cbi8vXG4vLyBgYmlub3BgLCB3aGVuIHByZXNlbnQsIHNwZWNpZmllcyB0aGF0IHRoaXMgb3BlcmF0b3IgaXMgYSBiaW5hcnlcbi8vIG9wZXJhdG9yLCBhbmQgd2lsbCByZWZlciB0byBpdHMgcHJlY2VkZW5jZS5cbi8vXG4vLyBgcHJlZml4YCBhbmQgYHBvc3RmaXhgIG1hcmsgdGhlIG9wZXJhdG9yIGFzIGEgcHJlZml4IG9yIHBvc3RmaXhcbi8vIHVuYXJ5IG9wZXJhdG9yLlxuLy9cbi8vIGBpc0Fzc2lnbmAgbWFya3MgYWxsIG9mIGA9YCwgYCs9YCwgYC09YCBldGNldGVyYSwgd2hpY2ggYWN0IGFzXG4vLyBiaW5hcnkgb3BlcmF0b3JzIHdpdGggYSB2ZXJ5IGxvdyBwcmVjZWRlbmNlLCB0aGF0IHNob3VsZCByZXN1bHRcbi8vIGluIEFzc2lnbm1lbnRFeHByZXNzaW9uIG5vZGVzLlxuZXE6bmV3IFRva2VuVHlwZShcIj1cIix7YmVmb3JlRXhwcjp0cnVlLGlzQXNzaWduOnRydWV9KSxhc3NpZ246bmV3IFRva2VuVHlwZShcIl89XCIse2JlZm9yZUV4cHI6dHJ1ZSxpc0Fzc2lnbjp0cnVlfSksaW5jRGVjOm5ldyBUb2tlblR5cGUoXCIrKy8tLVwiLHtwcmVmaXg6dHJ1ZSxwb3N0Zml4OnRydWUsc3RhcnRzRXhwcjp0cnVlfSkscHJlZml4Om5ldyBUb2tlblR5cGUoXCJwcmVmaXhcIix7YmVmb3JlRXhwcjp0cnVlLHByZWZpeDp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pLGxvZ2ljYWxPUjpiaW5vcChcInx8XCIsMSksbG9naWNhbEFORDpiaW5vcChcIiYmXCIsMiksYml0d2lzZU9SOmJpbm9wKFwifFwiLDMpLGJpdHdpc2VYT1I6Ymlub3AoXCJeXCIsNCksYml0d2lzZUFORDpiaW5vcChcIiZcIiw1KSxlcXVhbGl0eTpiaW5vcChcIj09LyE9XCIsNikscmVsYXRpb25hbDpiaW5vcChcIjwvPlwiLDcpLGJpdFNoaWZ0OmJpbm9wKFwiPDwvPj5cIiw4KSxwbHVzTWluOm5ldyBUb2tlblR5cGUoXCIrLy1cIix7YmVmb3JlRXhwcjp0cnVlLGJpbm9wOjkscHJlZml4OnRydWUsc3RhcnRzRXhwcjp0cnVlfSksbW9kdWxvOmJpbm9wKFwiJVwiLDEwKSxzdGFyOmJpbm9wKFwiKlwiLDEwKSxzbGFzaDpiaW5vcChcIi9cIiwxMCl9O2V4cG9ydHMudHlwZXMgPSB0eXBlczsgLy8gTWFwIGtleXdvcmQgbmFtZXMgdG8gdG9rZW4gdHlwZXMuXG52YXIga2V5d29yZHM9e307ZXhwb3J0cy5rZXl3b3JkcyA9IGtleXdvcmRzOyAvLyBTdWNjaW5jdCBkZWZpbml0aW9ucyBvZiBrZXl3b3JkIHRva2VuIHR5cGVzXG5mdW5jdGlvbiBrdyhuYW1lKXt2YXIgb3B0aW9ucz1hcmd1bWVudHMubGVuZ3RoIDw9IDEgfHwgYXJndW1lbnRzWzFdID09PSB1bmRlZmluZWQ/e306YXJndW1lbnRzWzFdO29wdGlvbnMua2V5d29yZCA9IG5hbWU7a2V5d29yZHNbbmFtZV0gPSB0eXBlc1tcIl9cIiArIG5hbWVdID0gbmV3IFRva2VuVHlwZShuYW1lLG9wdGlvbnMpO31rdyhcImJyZWFrXCIpO2t3KFwiY2FzZVwiLGJlZm9yZUV4cHIpO2t3KFwiY2F0Y2hcIik7a3coXCJjb250aW51ZVwiKTtrdyhcImRlYnVnZ2VyXCIpO2t3KFwiZGVmYXVsdFwiLGJlZm9yZUV4cHIpO2t3KFwiZG9cIix7aXNMb29wOnRydWV9KTtrdyhcImVsc2VcIixiZWZvcmVFeHByKTtrdyhcImZpbmFsbHlcIik7a3coXCJmb3JcIix7aXNMb29wOnRydWV9KTtrdyhcImZ1bmN0aW9uXCIsc3RhcnRzRXhwcik7a3coXCJpZlwiKTtrdyhcInJldHVyblwiLGJlZm9yZUV4cHIpO2t3KFwic3dpdGNoXCIpO2t3KFwidGhyb3dcIixiZWZvcmVFeHByKTtrdyhcInRyeVwiKTtrdyhcInZhclwiKTtrdyhcImxldFwiKTtrdyhcImNvbnN0XCIpO2t3KFwid2hpbGVcIix7aXNMb29wOnRydWV9KTtrdyhcIndpdGhcIik7a3coXCJuZXdcIix7YmVmb3JlRXhwcjp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pO2t3KFwidGhpc1wiLHN0YXJ0c0V4cHIpO2t3KFwic3VwZXJcIixzdGFydHNFeHByKTtrdyhcImNsYXNzXCIpO2t3KFwiZXh0ZW5kc1wiLGJlZm9yZUV4cHIpO2t3KFwiZXhwb3J0XCIpO2t3KFwiaW1wb3J0XCIpO2t3KFwieWllbGRcIix7YmVmb3JlRXhwcjp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pO2t3KFwibnVsbFwiLHN0YXJ0c0V4cHIpO2t3KFwidHJ1ZVwiLHN0YXJ0c0V4cHIpO2t3KFwiZmFsc2VcIixzdGFydHNFeHByKTtrdyhcImluXCIse2JlZm9yZUV4cHI6dHJ1ZSxiaW5vcDo3fSk7a3coXCJpbnN0YW5jZW9mXCIse2JlZm9yZUV4cHI6dHJ1ZSxiaW5vcDo3fSk7a3coXCJ0eXBlb2ZcIix7YmVmb3JlRXhwcjp0cnVlLHByZWZpeDp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pO2t3KFwidm9pZFwiLHtiZWZvcmVFeHByOnRydWUscHJlZml4OnRydWUsc3RhcnRzRXhwcjp0cnVlfSk7a3coXCJkZWxldGVcIix7YmVmb3JlRXhwcjp0cnVlLHByZWZpeDp0cnVlLHN0YXJ0c0V4cHI6dHJ1ZX0pO30se31dLDE1OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcInVzZSBzdHJpY3RcIjtleHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO2V4cG9ydHMuaXNBcnJheSA9IGlzQXJyYXk7ZXhwb3J0cy5oYXMgPSBoYXM7ZnVuY3Rpb24gaXNBcnJheShvYmope3JldHVybiBPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwob2JqKSA9PT0gXCJbb2JqZWN0IEFycmF5XVwiO30gLy8gQ2hlY2tzIGlmIGFuIG9iamVjdCBoYXMgYSBwcm9wZXJ0eS5cbmZ1bmN0aW9uIGhhcyhvYmoscHJvcE5hbWUpe3JldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLHByb3BOYW1lKTt9fSx7fV0sMTY6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpeyAvLyBNYXRjaGVzIGEgd2hvbGUgbGluZSBicmVhayAod2hlcmUgQ1JMRiBpcyBjb25zaWRlcmVkIGEgc2luZ2xlXG4vLyBsaW5lIGJyZWFrKS4gVXNlZCB0byBjb3VudCBsaW5lcy5cblwidXNlIHN0cmljdFwiO2V4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7ZXhwb3J0cy5pc05ld0xpbmUgPSBpc05ld0xpbmU7dmFyIGxpbmVCcmVhaz0vXFxyXFxuP3xcXG58XFx1MjAyOHxcXHUyMDI5LztleHBvcnRzLmxpbmVCcmVhayA9IGxpbmVCcmVhazt2YXIgbGluZUJyZWFrRz1uZXcgUmVnRXhwKGxpbmVCcmVhay5zb3VyY2UsXCJnXCIpO2V4cG9ydHMubGluZUJyZWFrRyA9IGxpbmVCcmVha0c7ZnVuY3Rpb24gaXNOZXdMaW5lKGNvZGUpe3JldHVybiBjb2RlID09PSAxMCB8fCBjb2RlID09PSAxMyB8fCBjb2RlID09PSAweDIwMjggfHwgY29kZSA9PSAweDIwMjk7fXZhciBub25BU0NJSXdoaXRlc3BhY2U9L1tcXHUxNjgwXFx1MTgwZVxcdTIwMDAtXFx1MjAwYVxcdTIwMmZcXHUyMDVmXFx1MzAwMFxcdWZlZmZdLztleHBvcnRzLm5vbkFTQ0lJd2hpdGVzcGFjZSA9IG5vbkFTQ0lJd2hpdGVzcGFjZTt9LHt9XX0se30sWzNdKSgzKTt9KTtcblxufSkuY2FsbCh0aGlzLHR5cGVvZiBnbG9iYWwgIT09IFwidW5kZWZpbmVkXCIgPyBnbG9iYWwgOiB0eXBlb2Ygc2VsZiAhPT0gXCJ1bmRlZmluZWRcIiA/IHNlbGYgOiB0eXBlb2Ygd2luZG93ICE9PSBcInVuZGVmaW5lZFwiID8gd2luZG93IDoge30pXG59LHt9XSwyOltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHR5cGVvZiBhY29ybiAhPSAndW5kZWZpbmVkJyA/IGFjb3JuIDogX2RlcmVxXyhcImFjb3JuXCIpO1xuXG59LHtcImFjb3JuXCI6MX1dLDM6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF9wYXJzZXV0aWwgPSBfZGVyZXFfKFwiLi9wYXJzZXV0aWxcIik7XG5cbnZhciBfID0gX2RlcmVxXyhcIi4uXCIpO1xuXG52YXIgbHAgPSBfc3RhdGUuTG9vc2VQYXJzZXIucHJvdG90eXBlO1xuXG5scC5jaGVja0xWYWwgPSBmdW5jdGlvbiAoZXhwciwgYmluZGluZykge1xuICBpZiAoIWV4cHIpIHJldHVybiBleHByO1xuICBzd2l0Y2ggKGV4cHIudHlwZSkge1xuICAgIGNhc2UgXCJJZGVudGlmaWVyXCI6XG4gICAgICByZXR1cm4gZXhwcjtcblxuICAgIGNhc2UgXCJNZW1iZXJFeHByZXNzaW9uXCI6XG4gICAgICByZXR1cm4gYmluZGluZyA/IHRoaXMuZHVtbXlJZGVudCgpIDogZXhwcjtcblxuICAgIGNhc2UgXCJQYXJlbnRoZXNpemVkRXhwcmVzc2lvblwiOlxuICAgICAgZXhwci5leHByZXNzaW9uID0gdGhpcy5jaGVja0xWYWwoZXhwci5leHByZXNzaW9uLCBiaW5kaW5nKTtcbiAgICAgIHJldHVybiBleHByO1xuXG4gICAgLy8gRklYTUUgcmVjdXJzaXZlbHkgY2hlY2sgY29udGVudHNcbiAgICBjYXNlIFwiT2JqZWN0UGF0dGVyblwiOlxuICAgIGNhc2UgXCJBcnJheVBhdHRlcm5cIjpcbiAgICBjYXNlIFwiUmVzdEVsZW1lbnRcIjpcbiAgICBjYXNlIFwiQXNzaWdubWVudFBhdHRlcm5cIjpcbiAgICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikgcmV0dXJuIGV4cHI7XG5cbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIHRoaXMuZHVtbXlJZGVudCgpO1xuICB9XG59O1xuXG5scC5wYXJzZUV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9Jbikge1xuICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKTtcbiAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuY29tbWEpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpO1xuICAgIG5vZGUuZXhwcmVzc2lvbnMgPSBbZXhwcl07XG4gICAgd2hpbGUgKHRoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpKSBub2RlLmV4cHJlc3Npb25zLnB1c2godGhpcy5wYXJzZU1heWJlQXNzaWduKG5vSW4pKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiU2VxdWVuY2VFeHByZXNzaW9uXCIpO1xuICB9XG4gIHJldHVybiBleHByO1xufTtcblxubHAucGFyc2VQYXJlbkV4cHJlc3Npb24gPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMucHVzaEN4KCk7XG4gIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMucGFyZW5MKTtcbiAgdmFyIHZhbCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMucG9wQ3goKTtcbiAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5wYXJlblIpO1xuICByZXR1cm4gdmFsO1xufTtcblxubHAucGFyc2VNYXliZUFzc2lnbiA9IGZ1bmN0aW9uIChub0luKSB7XG4gIHZhciBzdGFydCA9IHRoaXMuc3RvcmVDdXJyZW50UG9zKCk7XG4gIHZhciBsZWZ0ID0gdGhpcy5wYXJzZU1heWJlQ29uZGl0aW9uYWwobm9Jbik7XG4gIGlmICh0aGlzLnRvay50eXBlLmlzQXNzaWduKSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICBub2RlLm9wZXJhdG9yID0gdGhpcy50b2sudmFsdWU7XG4gICAgbm9kZS5sZWZ0ID0gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5lcSA/IHRoaXMudG9Bc3NpZ25hYmxlKGxlZnQpIDogdGhpcy5jaGVja0xWYWwobGVmdCk7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKTtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiQXNzaWdubWVudEV4cHJlc3Npb25cIik7XG4gIH1cbiAgcmV0dXJuIGxlZnQ7XG59O1xuXG5scC5wYXJzZU1heWJlQ29uZGl0aW9uYWwgPSBmdW5jdGlvbiAobm9Jbikge1xuICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICB2YXIgZXhwciA9IHRoaXMucGFyc2VFeHByT3BzKG5vSW4pO1xuICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5xdWVzdGlvbikpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpO1xuICAgIG5vZGUudGVzdCA9IGV4cHI7XG4gICAgbm9kZS5jb25zZXF1ZW50ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgbm9kZS5hbHRlcm5hdGUgPSB0aGlzLmV4cGVjdChfLnRva1R5cGVzLmNvbG9uKSA/IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKSA6IHRoaXMuZHVtbXlJZGVudCgpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJDb25kaXRpb25hbEV4cHJlc3Npb25cIik7XG4gIH1cbiAgcmV0dXJuIGV4cHI7XG59O1xuXG5scC5wYXJzZUV4cHJPcHMgPSBmdW5jdGlvbiAobm9Jbikge1xuICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICB2YXIgaW5kZW50ID0gdGhpcy5jdXJJbmRlbnQsXG4gICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gIHJldHVybiB0aGlzLnBhcnNlRXhwck9wKHRoaXMucGFyc2VNYXliZVVuYXJ5KG5vSW4pLCBzdGFydCwgLTEsIG5vSW4sIGluZGVudCwgbGluZSk7XG59O1xuXG5scC5wYXJzZUV4cHJPcCA9IGZ1bmN0aW9uIChsZWZ0LCBzdGFydCwgbWluUHJlYywgbm9JbiwgaW5kZW50LCBsaW5lKSB7XG4gIGlmICh0aGlzLmN1ckxpbmVTdGFydCAhPSBsaW5lICYmIHRoaXMuY3VySW5kZW50IDwgaW5kZW50ICYmIHRoaXMudG9rZW5TdGFydHNMaW5lKCkpIHJldHVybiBsZWZ0O1xuICB2YXIgcHJlYyA9IHRoaXMudG9rLnR5cGUuYmlub3A7XG4gIGlmIChwcmVjICE9IG51bGwgJiYgKCFub0luIHx8IHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMuX2luKSkge1xuICAgIGlmIChwcmVjID4gbWluUHJlYykge1xuICAgICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICAgIG5vZGUubGVmdCA9IGxlZnQ7XG4gICAgICBub2RlLm9wZXJhdG9yID0gdGhpcy50b2sudmFsdWU7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIGlmICh0aGlzLmN1ckxpbmVTdGFydCAhPSBsaW5lICYmIHRoaXMuY3VySW5kZW50IDwgaW5kZW50ICYmIHRoaXMudG9rZW5TdGFydHNMaW5lKCkpIHtcbiAgICAgICAgbm9kZS5yaWdodCA9IHRoaXMuZHVtbXlJZGVudCgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIHJpZ2h0U3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICAgICAgICBub2RlLnJpZ2h0ID0gdGhpcy5wYXJzZUV4cHJPcCh0aGlzLnBhcnNlTWF5YmVVbmFyeShub0luKSwgcmlnaHRTdGFydCwgcHJlYywgbm9JbiwgaW5kZW50LCBsaW5lKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuZmluaXNoTm9kZShub2RlLCAvJiZ8XFx8XFx8Ly50ZXN0KG5vZGUub3BlcmF0b3IpID8gXCJMb2dpY2FsRXhwcmVzc2lvblwiIDogXCJCaW5hcnlFeHByZXNzaW9uXCIpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VFeHByT3Aobm9kZSwgc3RhcnQsIG1pblByZWMsIG5vSW4sIGluZGVudCwgbGluZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBsZWZ0O1xufTtcblxubHAucGFyc2VNYXliZVVuYXJ5ID0gZnVuY3Rpb24gKG5vSW4pIHtcbiAgaWYgKHRoaXMudG9rLnR5cGUucHJlZml4KSB7XG4gICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpLFxuICAgICAgICB1cGRhdGUgPSB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmluY0RlYztcbiAgICBub2RlLm9wZXJhdG9yID0gdGhpcy50b2sudmFsdWU7XG4gICAgbm9kZS5wcmVmaXggPSB0cnVlO1xuICAgIHRoaXMubmV4dCgpO1xuICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlTWF5YmVVbmFyeShub0luKTtcbiAgICBpZiAodXBkYXRlKSBub2RlLmFyZ3VtZW50ID0gdGhpcy5jaGVja0xWYWwobm9kZS5hcmd1bWVudCk7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCB1cGRhdGUgPyBcIlVwZGF0ZUV4cHJlc3Npb25cIiA6IFwiVW5hcnlFeHByZXNzaW9uXCIpO1xuICB9IGVsc2UgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuZWxsaXBzaXMpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgbm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VNYXliZVVuYXJ5KG5vSW4pO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJTcHJlYWRFbGVtZW50XCIpO1xuICB9XG4gIHZhciBzdGFydCA9IHRoaXMuc3RvcmVDdXJyZW50UG9zKCk7XG4gIHZhciBleHByID0gdGhpcy5wYXJzZUV4cHJTdWJzY3JpcHRzKCk7XG4gIHdoaWxlICh0aGlzLnRvay50eXBlLnBvc3RmaXggJiYgIXRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkpIHtcbiAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpO1xuICAgIG5vZGUub3BlcmF0b3IgPSB0aGlzLnRvay52YWx1ZTtcbiAgICBub2RlLnByZWZpeCA9IGZhbHNlO1xuICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLmNoZWNrTFZhbChleHByKTtcbiAgICB0aGlzLm5leHQoKTtcbiAgICBleHByID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVXBkYXRlRXhwcmVzc2lvblwiKTtcbiAgfVxuICByZXR1cm4gZXhwcjtcbn07XG5cbmxwLnBhcnNlRXhwclN1YnNjcmlwdHMgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzdGFydCA9IHRoaXMuc3RvcmVDdXJyZW50UG9zKCk7XG4gIHJldHVybiB0aGlzLnBhcnNlU3Vic2NyaXB0cyh0aGlzLnBhcnNlRXhwckF0b20oKSwgc3RhcnQsIGZhbHNlLCB0aGlzLmN1ckluZGVudCwgdGhpcy5jdXJMaW5lU3RhcnQpO1xufTtcblxubHAucGFyc2VTdWJzY3JpcHRzID0gZnVuY3Rpb24gKGJhc2UsIHN0YXJ0LCBub0NhbGxzLCBzdGFydEluZGVudCwgbGluZSkge1xuICBmb3IgKDs7KSB7XG4gICAgaWYgKHRoaXMuY3VyTGluZVN0YXJ0ICE9IGxpbmUgJiYgdGhpcy5jdXJJbmRlbnQgPD0gc3RhcnRJbmRlbnQgJiYgdGhpcy50b2tlblN0YXJ0c0xpbmUoKSkge1xuICAgICAgaWYgKHRoaXMudG9rLnR5cGUgPT0gXy50b2tUeXBlcy5kb3QgJiYgdGhpcy5jdXJJbmRlbnQgPT0gc3RhcnRJbmRlbnQpIC0tc3RhcnRJbmRlbnQ7ZWxzZSByZXR1cm4gYmFzZTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5kb3QpKSB7XG4gICAgICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpO1xuICAgICAgbm9kZS5vYmplY3QgPSBiYXNlO1xuICAgICAgaWYgKHRoaXMuY3VyTGluZVN0YXJ0ICE9IGxpbmUgJiYgdGhpcy5jdXJJbmRlbnQgPD0gc3RhcnRJbmRlbnQgJiYgdGhpcy50b2tlblN0YXJ0c0xpbmUoKSkgbm9kZS5wcm9wZXJ0eSA9IHRoaXMuZHVtbXlJZGVudCgpO2Vsc2Ugbm9kZS5wcm9wZXJ0eSA9IHRoaXMucGFyc2VQcm9wZXJ0eUFjY2Vzc29yKCkgfHwgdGhpcy5kdW1teUlkZW50KCk7XG4gICAgICBub2RlLmNvbXB1dGVkID0gZmFsc2U7XG4gICAgICBiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTWVtYmVyRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMudG9rLnR5cGUgPT0gXy50b2tUeXBlcy5icmFja2V0TCkge1xuICAgICAgdGhpcy5wdXNoQ3goKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICAgIG5vZGUub2JqZWN0ID0gYmFzZTtcbiAgICAgIG5vZGUucHJvcGVydHkgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgICAgbm9kZS5jb21wdXRlZCA9IHRydWU7XG4gICAgICB0aGlzLnBvcEN4KCk7XG4gICAgICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLmJyYWNrZXRSKTtcbiAgICAgIGJhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJNZW1iZXJFeHByZXNzaW9uXCIpO1xuICAgIH0gZWxzZSBpZiAoIW5vQ2FsbHMgJiYgdGhpcy50b2sudHlwZSA9PSBfLnRva1R5cGVzLnBhcmVuTCkge1xuICAgICAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZUF0KHN0YXJ0KTtcbiAgICAgIG5vZGUuY2FsbGVlID0gYmFzZTtcbiAgICAgIG5vZGUuYXJndW1lbnRzID0gdGhpcy5wYXJzZUV4cHJMaXN0KF8udG9rVHlwZXMucGFyZW5SKTtcbiAgICAgIGJhc2UgPSB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJDYWxsRXhwcmVzc2lvblwiKTtcbiAgICB9IGVsc2UgaWYgKHRoaXMudG9rLnR5cGUgPT0gXy50b2tUeXBlcy5iYWNrUXVvdGUpIHtcbiAgICAgIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGVBdChzdGFydCk7XG4gICAgICBub2RlLnRhZyA9IGJhc2U7XG4gICAgICBub2RlLnF1YXNpID0gdGhpcy5wYXJzZVRlbXBsYXRlKCk7XG4gICAgICBiYXNlID0gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVGFnZ2VkVGVtcGxhdGVFeHByZXNzaW9uXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gYmFzZTtcbiAgICB9XG4gIH1cbn07XG5cbmxwLnBhcnNlRXhwckF0b20gPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdW5kZWZpbmVkO1xuICBzd2l0Y2ggKHRoaXMudG9rLnR5cGUpIHtcbiAgICBjYXNlIF8udG9rVHlwZXMuX3RoaXM6XG4gICAgY2FzZSBfLnRva1R5cGVzLl9zdXBlcjpcbiAgICAgIHZhciB0eXBlID0gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fdGhpcyA/IFwiVGhpc0V4cHJlc3Npb25cIiA6IFwiU3VwZXJcIjtcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIHR5cGUpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLm5hbWU6XG4gICAgICB2YXIgc3RhcnQgPSB0aGlzLnN0b3JlQ3VycmVudFBvcygpO1xuICAgICAgdmFyIGlkID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgICByZXR1cm4gdGhpcy5lYXQoXy50b2tUeXBlcy5hcnJvdykgPyB0aGlzLnBhcnNlQXJyb3dFeHByZXNzaW9uKHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpLCBbaWRdKSA6IGlkO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLnJlZ2V4cDpcbiAgICAgIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgICAgdmFyIHZhbCA9IHRoaXMudG9rLnZhbHVlO1xuICAgICAgbm9kZS5yZWdleCA9IHsgcGF0dGVybjogdmFsLnBhdHRlcm4sIGZsYWdzOiB2YWwuZmxhZ3MgfTtcbiAgICAgIG5vZGUudmFsdWUgPSB2YWwudmFsdWU7XG4gICAgICBub2RlLnJhdyA9IHRoaXMuaW5wdXQuc2xpY2UodGhpcy50b2suc3RhcnQsIHRoaXMudG9rLmVuZCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJMaXRlcmFsXCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLm51bTpjYXNlIF8udG9rVHlwZXMuc3RyaW5nOlxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICBub2RlLnZhbHVlID0gdGhpcy50b2sudmFsdWU7XG4gICAgICBub2RlLnJhdyA9IHRoaXMuaW5wdXQuc2xpY2UodGhpcy50b2suc3RhcnQsIHRoaXMudG9rLmVuZCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJMaXRlcmFsXCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9udWxsOmNhc2UgXy50b2tUeXBlcy5fdHJ1ZTpjYXNlIF8udG9rVHlwZXMuX2ZhbHNlOlxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICBub2RlLnZhbHVlID0gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fbnVsbCA/IG51bGwgOiB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl90cnVlO1xuICAgICAgbm9kZS5yYXcgPSB0aGlzLnRvay50eXBlLmtleXdvcmQ7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJMaXRlcmFsXCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLnBhcmVuTDpcbiAgICAgIHZhciBwYXJlblN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgdmFyIGlubmVyID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMucGFyZW5SKTtcbiAgICAgIGlmICh0aGlzLmVhdChfLnRva1R5cGVzLmFycm93KSkge1xuICAgICAgICByZXR1cm4gdGhpcy5wYXJzZUFycm93RXhwcmVzc2lvbih0aGlzLnN0YXJ0Tm9kZUF0KHBhcmVuU3RhcnQpLCBpbm5lci5leHByZXNzaW9ucyB8fCAoX3BhcnNldXRpbC5pc0R1bW15KGlubmVyKSA/IFtdIDogW2lubmVyXSkpO1xuICAgICAgfVxuICAgICAgaWYgKHRoaXMub3B0aW9ucy5wcmVzZXJ2ZVBhcmVucykge1xuICAgICAgICB2YXIgcGFyID0gdGhpcy5zdGFydE5vZGVBdChwYXJlblN0YXJ0KTtcbiAgICAgICAgcGFyLmV4cHJlc3Npb24gPSBpbm5lcjtcbiAgICAgICAgaW5uZXIgPSB0aGlzLmZpbmlzaE5vZGUocGFyLCBcIlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uXCIpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGlubmVyO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLmJyYWNrZXRMOlxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICBub2RlLmVsZW1lbnRzID0gdGhpcy5wYXJzZUV4cHJMaXN0KF8udG9rVHlwZXMuYnJhY2tldFIsIHRydWUpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkFycmF5RXhwcmVzc2lvblwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5icmFjZUw6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZU9iaigpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9jbGFzczpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlQ2xhc3MoKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fZnVuY3Rpb246XG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgcmV0dXJuIHRoaXMucGFyc2VGdW5jdGlvbihub2RlLCBmYWxzZSk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX25ldzpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlTmV3KCk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3lpZWxkOlxuICAgICAgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIGlmICh0aGlzLnNlbWljb2xvbigpIHx8IHRoaXMuY2FuSW5zZXJ0U2VtaWNvbG9uKCkgfHwgdGhpcy50b2sudHlwZSAhPSBfLnRva1R5cGVzLnN0YXIgJiYgIXRoaXMudG9rLnR5cGUuc3RhcnRzRXhwcikge1xuICAgICAgICBub2RlLmRlbGVnYXRlID0gZmFsc2U7XG4gICAgICAgIG5vZGUuYXJndW1lbnQgPSBudWxsO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbm9kZS5kZWxlZ2F0ZSA9IHRoaXMuZWF0KF8udG9rVHlwZXMuc3Rhcik7XG4gICAgICAgIG5vZGUuYXJndW1lbnQgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJZaWVsZEV4cHJlc3Npb25cIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuYmFja1F1b3RlOlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VUZW1wbGF0ZSgpO1xuXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiB0aGlzLmR1bW15SWRlbnQoKTtcbiAgfVxufTtcblxubHAucGFyc2VOZXcgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKSxcbiAgICAgIHN0YXJ0SW5kZW50ID0gdGhpcy5jdXJJbmRlbnQsXG4gICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gIHZhciBtZXRhID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgdGhpcy5lYXQoXy50b2tUeXBlcy5kb3QpKSB7XG4gICAgbm9kZS5tZXRhID0gbWV0YTtcbiAgICBub2RlLnByb3BlcnR5ID0gdGhpcy5wYXJzZUlkZW50KHRydWUpO1xuICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJNZXRhUHJvcGVydHlcIik7XG4gIH1cbiAgdmFyIHN0YXJ0ID0gdGhpcy5zdG9yZUN1cnJlbnRQb3MoKTtcbiAgbm9kZS5jYWxsZWUgPSB0aGlzLnBhcnNlU3Vic2NyaXB0cyh0aGlzLnBhcnNlRXhwckF0b20oKSwgc3RhcnQsIHRydWUsIHN0YXJ0SW5kZW50LCBsaW5lKTtcbiAgaWYgKHRoaXMudG9rLnR5cGUgPT0gXy50b2tUeXBlcy5wYXJlbkwpIHtcbiAgICBub2RlLmFyZ3VtZW50cyA9IHRoaXMucGFyc2VFeHByTGlzdChfLnRva1R5cGVzLnBhcmVuUik7XG4gIH0gZWxzZSB7XG4gICAgbm9kZS5hcmd1bWVudHMgPSBbXTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiTmV3RXhwcmVzc2lvblwiKTtcbn07XG5cbmxwLnBhcnNlVGVtcGxhdGVFbGVtZW50ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgZWxlbSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIGVsZW0udmFsdWUgPSB7XG4gICAgcmF3OiB0aGlzLmlucHV0LnNsaWNlKHRoaXMudG9rLnN0YXJ0LCB0aGlzLnRvay5lbmQpLnJlcGxhY2UoL1xcclxcbj8vZywgJ1xcbicpLFxuICAgIGNvb2tlZDogdGhpcy50b2sudmFsdWVcbiAgfTtcbiAgdGhpcy5uZXh0KCk7XG4gIGVsZW0udGFpbCA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuYmFja1F1b3RlO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKGVsZW0sIFwiVGVtcGxhdGVFbGVtZW50XCIpO1xufTtcblxubHAucGFyc2VUZW1wbGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5leHByZXNzaW9ucyA9IFtdO1xuICB2YXIgY3VyRWx0ID0gdGhpcy5wYXJzZVRlbXBsYXRlRWxlbWVudCgpO1xuICBub2RlLnF1YXNpcyA9IFtjdXJFbHRdO1xuICB3aGlsZSAoIWN1ckVsdC50YWlsKSB7XG4gICAgdGhpcy5uZXh0KCk7XG4gICAgbm9kZS5leHByZXNzaW9ucy5wdXNoKHRoaXMucGFyc2VFeHByZXNzaW9uKCkpO1xuICAgIGlmICh0aGlzLmV4cGVjdChfLnRva1R5cGVzLmJyYWNlUikpIHtcbiAgICAgIGN1ckVsdCA9IHRoaXMucGFyc2VUZW1wbGF0ZUVsZW1lbnQoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3VyRWx0ID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIGN1ckVsdC52YWx1ZSA9IHsgY29va2VkOiAnJywgcmF3OiAnJyB9O1xuICAgICAgY3VyRWx0LnRhaWwgPSB0cnVlO1xuICAgIH1cbiAgICBub2RlLnF1YXNpcy5wdXNoKGN1ckVsdCk7XG4gIH1cbiAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5iYWNrUXVvdGUpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVGVtcGxhdGVMaXRlcmFsXCIpO1xufTtcblxubHAucGFyc2VPYmogPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgbm9kZS5wcm9wZXJ0aWVzID0gW107XG4gIHRoaXMucHVzaEN4KCk7XG4gIHZhciBpbmRlbnQgPSB0aGlzLmN1ckluZGVudCArIDEsXG4gICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VMKTtcbiAgaWYgKHRoaXMuY3VySW5kZW50ICsgMSA8IGluZGVudCkge1xuICAgIGluZGVudCA9IHRoaXMuY3VySW5kZW50O2xpbmUgPSB0aGlzLmN1ckxpbmVTdGFydDtcbiAgfVxuICB3aGlsZSAoIXRoaXMuY2xvc2VzKF8udG9rVHlwZXMuYnJhY2VSLCBpbmRlbnQsIGxpbmUpKSB7XG4gICAgdmFyIHByb3AgPSB0aGlzLnN0YXJ0Tm9kZSgpLFxuICAgICAgICBpc0dlbmVyYXRvciA9IHVuZGVmaW5lZCxcbiAgICAgICAgc3RhcnQgPSB1bmRlZmluZWQ7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgICBzdGFydCA9IHRoaXMuc3RvcmVDdXJyZW50UG9zKCk7XG4gICAgICBwcm9wLm1ldGhvZCA9IGZhbHNlO1xuICAgICAgcHJvcC5zaG9ydGhhbmQgPSBmYWxzZTtcbiAgICAgIGlzR2VuZXJhdG9yID0gdGhpcy5lYXQoXy50b2tUeXBlcy5zdGFyKTtcbiAgICB9XG4gICAgdGhpcy5wYXJzZVByb3BlcnR5TmFtZShwcm9wKTtcbiAgICBpZiAoX3BhcnNldXRpbC5pc0R1bW15KHByb3Aua2V5KSkge1xuICAgICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teSh0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKSkpIHRoaXMubmV4dCgpO3RoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpO2NvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5jb2xvbikpIHtcbiAgICAgIHByb3Aua2luZCA9IFwiaW5pdFwiO1xuICAgICAgcHJvcC52YWx1ZSA9IHRoaXMucGFyc2VNYXliZUFzc2lnbigpO1xuICAgIH0gZWxzZSBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgJiYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMucGFyZW5MIHx8IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuYnJhY2VMKSkge1xuICAgICAgcHJvcC5raW5kID0gXCJpbml0XCI7XG4gICAgICBwcm9wLm1ldGhvZCA9IHRydWU7XG4gICAgICBwcm9wLnZhbHVlID0gdGhpcy5wYXJzZU1ldGhvZChpc0dlbmVyYXRvcik7XG4gICAgfSBlbHNlIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNSAmJiBwcm9wLmtleS50eXBlID09PSBcIklkZW50aWZpZXJcIiAmJiAhcHJvcC5jb21wdXRlZCAmJiAocHJvcC5rZXkubmFtZSA9PT0gXCJnZXRcIiB8fCBwcm9wLmtleS5uYW1lID09PSBcInNldFwiKSAmJiAodGhpcy50b2sudHlwZSAhPSBfLnRva1R5cGVzLmNvbW1hICYmIHRoaXMudG9rLnR5cGUgIT0gXy50b2tUeXBlcy5icmFjZVIpKSB7XG4gICAgICBwcm9wLmtpbmQgPSBwcm9wLmtleS5uYW1lO1xuICAgICAgdGhpcy5wYXJzZVByb3BlcnR5TmFtZShwcm9wKTtcbiAgICAgIHByb3AudmFsdWUgPSB0aGlzLnBhcnNlTWV0aG9kKGZhbHNlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvcC5raW5kID0gXCJpbml0XCI7XG4gICAgICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICAgICAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuZXEpKSB7XG4gICAgICAgICAgdmFyIGFzc2lnbiA9IHRoaXMuc3RhcnROb2RlQXQoc3RhcnQpO1xuICAgICAgICAgIGFzc2lnbi5vcGVyYXRvciA9IFwiPVwiO1xuICAgICAgICAgIGFzc2lnbi5sZWZ0ID0gcHJvcC5rZXk7XG4gICAgICAgICAgYXNzaWduLnJpZ2h0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgICAgICAgcHJvcC52YWx1ZSA9IHRoaXMuZmluaXNoTm9kZShhc3NpZ24sIFwiQXNzaWdubWVudEV4cHJlc3Npb25cIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcHJvcC52YWx1ZSA9IHByb3Aua2V5O1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcm9wLnZhbHVlID0gdGhpcy5kdW1teUlkZW50KCk7XG4gICAgICB9XG4gICAgICBwcm9wLnNob3J0aGFuZCA9IHRydWU7XG4gICAgfVxuICAgIG5vZGUucHJvcGVydGllcy5wdXNoKHRoaXMuZmluaXNoTm9kZShwcm9wLCBcIlByb3BlcnR5XCIpKTtcbiAgICB0aGlzLmVhdChfLnRva1R5cGVzLmNvbW1hKTtcbiAgfVxuICB0aGlzLnBvcEN4KCk7XG4gIGlmICghdGhpcy5lYXQoXy50b2tUeXBlcy5icmFjZVIpKSB7XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xvc2luZyBicmFjZSwgbWFrZSB0aGUgbm9kZSBzcGFuIHRvIHRoZSBzdGFydFxuICAgIC8vIG9mIHRoZSBuZXh0IHRva2VuICh0aGlzIGlzIHVzZWZ1bCBmb3IgVGVybilcbiAgICB0aGlzLmxhc3QuZW5kID0gdGhpcy50b2suc3RhcnQ7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHRoaXMubGFzdC5sb2MuZW5kID0gdGhpcy50b2subG9jLnN0YXJ0O1xuICB9XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJPYmplY3RFeHByZXNzaW9uXCIpO1xufTtcblxubHAucGFyc2VQcm9wZXJ0eU5hbWUgPSBmdW5jdGlvbiAocHJvcCkge1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5icmFja2V0TCkpIHtcbiAgICAgIHByb3AuY29tcHV0ZWQgPSB0cnVlO1xuICAgICAgcHJvcC5rZXkgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgICAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5icmFja2V0Uik7XG4gICAgICByZXR1cm47XG4gICAgfSBlbHNlIHtcbiAgICAgIHByb3AuY29tcHV0ZWQgPSBmYWxzZTtcbiAgICB9XG4gIH1cbiAgdmFyIGtleSA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMubnVtIHx8IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuc3RyaW5nID8gdGhpcy5wYXJzZUV4cHJBdG9tKCkgOiB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgcHJvcC5rZXkgPSBrZXkgfHwgdGhpcy5kdW1teUlkZW50KCk7XG59O1xuXG5scC5wYXJzZVByb3BlcnR5QWNjZXNzb3IgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUgfHwgdGhpcy50b2sudHlwZS5rZXl3b3JkKSByZXR1cm4gdGhpcy5wYXJzZUlkZW50KCk7XG59O1xuXG5scC5wYXJzZUlkZW50ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbmFtZSA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMubmFtZSA/IHRoaXMudG9rLnZhbHVlIDogdGhpcy50b2sudHlwZS5rZXl3b3JkO1xuICBpZiAoIW5hbWUpIHJldHVybiB0aGlzLmR1bW15SWRlbnQoKTtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5uYW1lID0gbmFtZTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIklkZW50aWZpZXJcIik7XG59O1xuXG5scC5pbml0RnVuY3Rpb24gPSBmdW5jdGlvbiAobm9kZSkge1xuICBub2RlLmlkID0gbnVsbDtcbiAgbm9kZS5wYXJhbXMgPSBbXTtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgbm9kZS5nZW5lcmF0b3IgPSBmYWxzZTtcbiAgICBub2RlLmV4cHJlc3Npb24gPSBmYWxzZTtcbiAgfVxufTtcblxuLy8gQ29udmVydCBleGlzdGluZyBleHByZXNzaW9uIGF0b20gdG8gYXNzaWduYWJsZSBwYXR0ZXJuXG4vLyBpZiBwb3NzaWJsZS5cblxubHAudG9Bc3NpZ25hYmxlID0gZnVuY3Rpb24gKG5vZGUsIGJpbmRpbmcpIHtcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIG5vZGUpIHtcbiAgICBzd2l0Y2ggKG5vZGUudHlwZSkge1xuICAgICAgY2FzZSBcIk9iamVjdEV4cHJlc3Npb25cIjpcbiAgICAgICAgbm9kZS50eXBlID0gXCJPYmplY3RQYXR0ZXJuXCI7XG4gICAgICAgIHZhciBwcm9wcyA9IG5vZGUucHJvcGVydGllcztcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBwcm9wcy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgIHRoaXMudG9Bc3NpZ25hYmxlKHByb3BzW2ldLnZhbHVlLCBiaW5kaW5nKTtcbiAgICAgICAgfWJyZWFrO1xuXG4gICAgICBjYXNlIFwiQXJyYXlFeHByZXNzaW9uXCI6XG4gICAgICAgIG5vZGUudHlwZSA9IFwiQXJyYXlQYXR0ZXJuXCI7XG4gICAgICAgIHRoaXMudG9Bc3NpZ25hYmxlTGlzdChub2RlLmVsZW1lbnRzLCBiaW5kaW5nKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJTcHJlYWRFbGVtZW50XCI6XG4gICAgICAgIG5vZGUudHlwZSA9IFwiUmVzdEVsZW1lbnRcIjtcbiAgICAgICAgbm9kZS5hcmd1bWVudCA9IHRoaXMudG9Bc3NpZ25hYmxlKG5vZGUuYXJndW1lbnQsIGJpbmRpbmcpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIkFzc2lnbm1lbnRFeHByZXNzaW9uXCI6XG4gICAgICAgIG5vZGUudHlwZSA9IFwiQXNzaWdubWVudFBhdHRlcm5cIjtcbiAgICAgICAgZGVsZXRlIG5vZGUub3BlcmF0b3I7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdGhpcy5jaGVja0xWYWwobm9kZSwgYmluZGluZyk7XG59O1xuXG5scC50b0Fzc2lnbmFibGVMaXN0ID0gZnVuY3Rpb24gKGV4cHJMaXN0LCBiaW5kaW5nKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgZXhwckxpc3QubGVuZ3RoOyBpKyspIHtcbiAgICBleHByTGlzdFtpXSA9IHRoaXMudG9Bc3NpZ25hYmxlKGV4cHJMaXN0W2ldLCBiaW5kaW5nKTtcbiAgfXJldHVybiBleHByTGlzdDtcbn07XG5cbmxwLnBhcnNlRnVuY3Rpb25QYXJhbXMgPSBmdW5jdGlvbiAocGFyYW1zKSB7XG4gIHBhcmFtcyA9IHRoaXMucGFyc2VFeHByTGlzdChfLnRva1R5cGVzLnBhcmVuUik7XG4gIHJldHVybiB0aGlzLnRvQXNzaWduYWJsZUxpc3QocGFyYW1zLCB0cnVlKTtcbn07XG5cbmxwLnBhcnNlTWV0aG9kID0gZnVuY3Rpb24gKGlzR2VuZXJhdG9yKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgdGhpcy5pbml0RnVuY3Rpb24obm9kZSk7XG4gIG5vZGUucGFyYW1zID0gdGhpcy5wYXJzZUZ1bmN0aW9uUGFyYW1zKCk7XG4gIG5vZGUuZ2VuZXJhdG9yID0gaXNHZW5lcmF0b3IgfHwgZmFsc2U7XG4gIG5vZGUuZXhwcmVzc2lvbiA9IHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2ICYmIHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMuYnJhY2VMO1xuICBub2RlLmJvZHkgPSBub2RlLmV4cHJlc3Npb24gPyB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKSA6IHRoaXMucGFyc2VCbG9jaygpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRnVuY3Rpb25FeHByZXNzaW9uXCIpO1xufTtcblxubHAucGFyc2VBcnJvd0V4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgcGFyYW1zKSB7XG4gIHRoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO1xuICBub2RlLnBhcmFtcyA9IHRoaXMudG9Bc3NpZ25hYmxlTGlzdChwYXJhbXMsIHRydWUpO1xuICBub2RlLmV4cHJlc3Npb24gPSB0aGlzLnRvay50eXBlICE9PSBfLnRva1R5cGVzLmJyYWNlTDtcbiAgbm9kZS5ib2R5ID0gbm9kZS5leHByZXNzaW9uID8gdGhpcy5wYXJzZU1heWJlQXNzaWduKCkgOiB0aGlzLnBhcnNlQmxvY2soKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkFycm93RnVuY3Rpb25FeHByZXNzaW9uXCIpO1xufTtcblxubHAucGFyc2VFeHByTGlzdCA9IGZ1bmN0aW9uIChjbG9zZSwgYWxsb3dFbXB0eSkge1xuICB0aGlzLnB1c2hDeCgpO1xuICB2YXIgaW5kZW50ID0gdGhpcy5jdXJJbmRlbnQsXG4gICAgICBsaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQsXG4gICAgICBlbHRzID0gW107XG4gIHRoaXMubmV4dCgpOyAvLyBPcGVuaW5nIGJyYWNrZXRcbiAgd2hpbGUgKCF0aGlzLmNsb3NlcyhjbG9zZSwgaW5kZW50ICsgMSwgbGluZSkpIHtcbiAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSkpIHtcbiAgICAgIGVsdHMucHVzaChhbGxvd0VtcHR5ID8gbnVsbCA6IHRoaXMuZHVtbXlJZGVudCgpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB2YXIgZWx0ID0gdGhpcy5wYXJzZU1heWJlQXNzaWduKCk7XG4gICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teShlbHQpKSB7XG4gICAgICBpZiAodGhpcy5jbG9zZXMoY2xvc2UsIGluZGVudCwgbGluZSkpIGJyZWFrO1xuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGVsdHMucHVzaChlbHQpO1xuICAgIH1cbiAgICB0aGlzLmVhdChfLnRva1R5cGVzLmNvbW1hKTtcbiAgfVxuICB0aGlzLnBvcEN4KCk7XG4gIGlmICghdGhpcy5lYXQoY2xvc2UpKSB7XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xvc2luZyBicmFjZSwgbWFrZSB0aGUgbm9kZSBzcGFuIHRvIHRoZSBzdGFydFxuICAgIC8vIG9mIHRoZSBuZXh0IHRva2VuICh0aGlzIGlzIHVzZWZ1bCBmb3IgVGVybilcbiAgICB0aGlzLmxhc3QuZW5kID0gdGhpcy50b2suc3RhcnQ7XG4gICAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHRoaXMubGFzdC5sb2MuZW5kID0gdGhpcy50b2subG9jLnN0YXJ0O1xuICB9XG4gIHJldHVybiBlbHRzO1xufTtcblxufSx7XCIuLlwiOjIsXCIuL3BhcnNldXRpbFwiOjUsXCIuL3N0YXRlXCI6Nn1dLDQ6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuLy8gQWNvcm46IExvb3NlIHBhcnNlclxuLy9cbi8vIFRoaXMgbW9kdWxlIHByb3ZpZGVzIGFuIGFsdGVybmF0aXZlIHBhcnNlciAoYHBhcnNlX2RhbW1pdGApIHRoYXRcbi8vIGV4cG9zZXMgdGhhdCBzYW1lIGludGVyZmFjZSBhcyBgcGFyc2VgLCBidXQgd2lsbCB0cnkgdG8gcGFyc2Vcbi8vIGFueXRoaW5nIGFzIEphdmFTY3JpcHQsIHJlcGFpcmluZyBzeW50YXggZXJyb3IgdGhlIGJlc3QgaXQgY2FuLlxuLy8gVGhlcmUgYXJlIGNpcmN1bXN0YW5jZXMgaW4gd2hpY2ggaXQgd2lsbCByYWlzZSBhbiBlcnJvciBhbmQgZ2l2ZVxuLy8gdXAsIGJ1dCB0aGV5IGFyZSB2ZXJ5IHJhcmUuIFRoZSByZXN1bHRpbmcgQVNUIHdpbGwgYmUgYSBtb3N0bHlcbi8vIHZhbGlkIEphdmFTY3JpcHQgQVNUIChhcyBwZXIgdGhlIFtNb3ppbGxhIHBhcnNlciBBUEldW2FwaV0sIGV4Y2VwdFxuLy8gdGhhdDpcbi8vXG4vLyAtIFJldHVybiBvdXRzaWRlIGZ1bmN0aW9ucyBpcyBhbGxvd2VkXG4vL1xuLy8gLSBMYWJlbCBjb25zaXN0ZW5jeSAobm8gY29uZmxpY3RzLCBicmVhayBvbmx5IHRvIGV4aXN0aW5nIGxhYmVscylcbi8vICAgaXMgbm90IGVuZm9yY2VkLlxuLy9cbi8vIC0gQm9ndXMgSWRlbnRpZmllciBub2RlcyB3aXRoIGEgbmFtZSBvZiBgXCLinJZcImAgYXJlIGluc2VydGVkIHdoZW5ldmVyXG4vLyAgIHRoZSBwYXJzZXIgZ290IHRvbyBjb25mdXNlZCB0byByZXR1cm4gYW55dGhpbmcgbWVhbmluZ2Z1bC5cbi8vXG4vLyBbYXBpXTogaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9TcGlkZXJNb25rZXkvUGFyc2VyX0FQSVxuLy9cbi8vIFRoZSBleHBlY3RlZCB1c2UgZm9yIHRoaXMgaXMgdG8gKmZpcnN0KiB0cnkgYGFjb3JuLnBhcnNlYCwgYW5kIG9ubHlcbi8vIGlmIHRoYXQgZmFpbHMgc3dpdGNoIHRvIGBwYXJzZV9kYW1taXRgLiBUaGUgbG9vc2UgcGFyc2VyIG1pZ2h0XG4vLyBwYXJzZSBiYWRseSBpbmRlbnRlZCBjb2RlIGluY29ycmVjdGx5LCBzbyAqKmRvbid0KiogdXNlIGl0IGFzXG4vLyB5b3VyIGRlZmF1bHQgcGFyc2VyLlxuLy9cbi8vIFF1aXRlIGEgbG90IG9mIGFjb3JuLmpzIGlzIGR1cGxpY2F0ZWQgaGVyZS4gVGhlIGFsdGVybmF0aXZlIHdhcyB0b1xuLy8gYWRkIGEgKmxvdCogb2YgZXh0cmEgY3J1ZnQgdG8gdGhhdCBmaWxlLCBtYWtpbmcgaXQgbGVzcyByZWFkYWJsZVxuLy8gYW5kIHNsb3dlci4gQ29weWluZyBhbmQgZWRpdGluZyB0aGUgY29kZSBhbGxvd2VkIG1lIHRvIG1ha2Vcbi8vIGludmFzaXZlIGNoYW5nZXMgYW5kIHNpbXBsaWZpY2F0aW9ucyB3aXRob3V0IGNyZWF0aW5nIGEgY29tcGxpY2F0ZWRcbi8vIHRhbmdsZS5cblxuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzLnBhcnNlX2RhbW1pdCA9IHBhcnNlX2RhbW1pdDtcblxuZnVuY3Rpb24gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQob2JqKSB7IGlmIChvYmogJiYgb2JqLl9fZXNNb2R1bGUpIHsgcmV0dXJuIG9iajsgfSBlbHNlIHsgdmFyIG5ld09iaiA9IHt9OyBpZiAob2JqICE9IG51bGwpIHsgZm9yICh2YXIga2V5IGluIG9iaikgeyBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKG9iaiwga2V5KSkgbmV3T2JqW2tleV0gPSBvYmpba2V5XTsgfSB9IG5ld09ialtcImRlZmF1bHRcIl0gPSBvYmo7IHJldHVybiBuZXdPYmo7IH0gfVxuXG52YXIgXyA9IF9kZXJlcV8oXCIuLlwiKTtcblxudmFyIGFjb3JuID0gX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQoXyk7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxuX2RlcmVxXyhcIi4vdG9rZW5pemVcIik7XG5cbl9kZXJlcV8oXCIuL3N0YXRlbWVudFwiKTtcblxuX2RlcmVxXyhcIi4vZXhwcmVzc2lvblwiKTtcblxuZXhwb3J0cy5Mb29zZVBhcnNlciA9IF9zdGF0ZS5Mb29zZVBhcnNlcjtcblxuYWNvcm4uZGVmYXVsdE9wdGlvbnMudGFiU2l6ZSA9IDQ7XG5cbmZ1bmN0aW9uIHBhcnNlX2RhbW1pdChpbnB1dCwgb3B0aW9ucykge1xuICB2YXIgcCA9IG5ldyBfc3RhdGUuTG9vc2VQYXJzZXIoaW5wdXQsIG9wdGlvbnMpO1xuICBwLm5leHQoKTtcbiAgcmV0dXJuIHAucGFyc2VUb3BMZXZlbCgpO1xufVxuXG5hY29ybi5wYXJzZV9kYW1taXQgPSBwYXJzZV9kYW1taXQ7XG5hY29ybi5Mb29zZVBhcnNlciA9IF9zdGF0ZS5Mb29zZVBhcnNlcjtcblxufSx7XCIuLlwiOjIsXCIuL2V4cHJlc3Npb25cIjozLFwiLi9zdGF0ZVwiOjYsXCIuL3N0YXRlbWVudFwiOjcsXCIuL3Rva2VuaXplXCI6OH1dLDU6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmV4cG9ydHMuX19lc01vZHVsZSA9IHRydWU7XG5leHBvcnRzLmlzRHVtbXkgPSBpc0R1bW15O1xuXG5mdW5jdGlvbiBpc0R1bW15KG5vZGUpIHtcbiAgcmV0dXJuIG5vZGUubmFtZSA9PSBcIuKcllwiO1xufVxuXG59LHt9XSw2OltmdW5jdGlvbihfZGVyZXFfLG1vZHVsZSxleHBvcnRzKXtcblwidXNlIHN0cmljdFwiO1xuXG5leHBvcnRzLl9fZXNNb2R1bGUgPSB0cnVlO1xuXG5mdW5jdGlvbiBfY2xhc3NDYWxsQ2hlY2soaW5zdGFuY2UsIENvbnN0cnVjdG9yKSB7IGlmICghKGluc3RhbmNlIGluc3RhbmNlb2YgQ29uc3RydWN0b3IpKSB7IHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgY2FsbCBhIGNsYXNzIGFzIGEgZnVuY3Rpb25cIik7IH0gfVxuXG52YXIgXyA9IF9kZXJlcV8oXCIuLlwiKTtcblxudmFyIExvb3NlUGFyc2VyID0gKGZ1bmN0aW9uICgpIHtcbiAgZnVuY3Rpb24gTG9vc2VQYXJzZXIoaW5wdXQsIG9wdGlvbnMpIHtcbiAgICBfY2xhc3NDYWxsQ2hlY2sodGhpcywgTG9vc2VQYXJzZXIpO1xuXG4gICAgdGhpcy50b2tzID0gXy50b2tlbml6ZXIoaW5wdXQsIG9wdGlvbnMpO1xuICAgIHRoaXMub3B0aW9ucyA9IHRoaXMudG9rcy5vcHRpb25zO1xuICAgIHRoaXMuaW5wdXQgPSB0aGlzLnRva3MuaW5wdXQ7XG4gICAgdGhpcy50b2sgPSB0aGlzLmxhc3QgPSB7IHR5cGU6IF8udG9rVHlwZXMuZW9mLCBzdGFydDogMCwgZW5kOiAwIH07XG4gICAgaWYgKHRoaXMub3B0aW9ucy5sb2NhdGlvbnMpIHtcbiAgICAgIHZhciBoZXJlID0gdGhpcy50b2tzLmN1clBvc2l0aW9uKCk7XG4gICAgICB0aGlzLnRvay5sb2MgPSBuZXcgXy5Tb3VyY2VMb2NhdGlvbih0aGlzLnRva3MsIGhlcmUsIGhlcmUpO1xuICAgIH1cbiAgICB0aGlzLmFoZWFkID0gW107IC8vIFRva2VucyBhaGVhZFxuICAgIHRoaXMuY29udGV4dCA9IFtdOyAvLyBJbmRlbnRhdGlvbiBjb250ZXh0ZWRcbiAgICB0aGlzLmN1ckluZGVudCA9IDA7XG4gICAgdGhpcy5jdXJMaW5lU3RhcnQgPSAwO1xuICAgIHRoaXMubmV4dExpbmVTdGFydCA9IHRoaXMubGluZUVuZCh0aGlzLmN1ckxpbmVTdGFydCkgKyAxO1xuICB9XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLnN0YXJ0Tm9kZSA9IGZ1bmN0aW9uIHN0YXJ0Tm9kZSgpIHtcbiAgICByZXR1cm4gbmV3IF8uTm9kZSh0aGlzLnRva3MsIHRoaXMudG9rLnN0YXJ0LCB0aGlzLm9wdGlvbnMubG9jYXRpb25zID8gdGhpcy50b2subG9jLnN0YXJ0IDogbnVsbCk7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLnN0b3JlQ3VycmVudFBvcyA9IGZ1bmN0aW9uIHN0b3JlQ3VycmVudFBvcygpIHtcbiAgICByZXR1cm4gdGhpcy5vcHRpb25zLmxvY2F0aW9ucyA/IFt0aGlzLnRvay5zdGFydCwgdGhpcy50b2subG9jLnN0YXJ0XSA6IHRoaXMudG9rLnN0YXJ0O1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5zdGFydE5vZGVBdCA9IGZ1bmN0aW9uIHN0YXJ0Tm9kZUF0KHBvcykge1xuICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgICByZXR1cm4gbmV3IF8uTm9kZSh0aGlzLnRva3MsIHBvc1swXSwgcG9zWzFdKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIG5ldyBfLk5vZGUodGhpcy50b2tzLCBwb3MpO1xuICAgIH1cbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuZmluaXNoTm9kZSA9IGZ1bmN0aW9uIGZpbmlzaE5vZGUobm9kZSwgdHlwZSkge1xuICAgIG5vZGUudHlwZSA9IHR5cGU7XG4gICAgbm9kZS5lbmQgPSB0aGlzLmxhc3QuZW5kO1xuICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSBub2RlLmxvYy5lbmQgPSB0aGlzLmxhc3QubG9jLmVuZDtcbiAgICBpZiAodGhpcy5vcHRpb25zLnJhbmdlcykgbm9kZS5yYW5nZVsxXSA9IHRoaXMubGFzdC5lbmQ7XG4gICAgcmV0dXJuIG5vZGU7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLmR1bW15SWRlbnQgPSBmdW5jdGlvbiBkdW1teUlkZW50KCkge1xuICAgIHZhciBkdW1teSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgZHVtbXkubmFtZSA9IFwi4pyWXCI7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShkdW1teSwgXCJJZGVudGlmaWVyXCIpO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5lYXQgPSBmdW5jdGlvbiBlYXQodHlwZSkge1xuICAgIGlmICh0aGlzLnRvay50eXBlID09PSB0eXBlKSB7XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5pc0NvbnRleHR1YWwgPSBmdW5jdGlvbiBpc0NvbnRleHR1YWwobmFtZSkge1xuICAgIHJldHVybiB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUgJiYgdGhpcy50b2sudmFsdWUgPT09IG5hbWU7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLmVhdENvbnRleHR1YWwgPSBmdW5jdGlvbiBlYXRDb250ZXh0dWFsKG5hbWUpIHtcbiAgICByZXR1cm4gdGhpcy50b2sudmFsdWUgPT09IG5hbWUgJiYgdGhpcy5lYXQoXy50b2tUeXBlcy5uYW1lKTtcbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuY2FuSW5zZXJ0U2VtaWNvbG9uID0gZnVuY3Rpb24gY2FuSW5zZXJ0U2VtaWNvbG9uKCkge1xuICAgIHJldHVybiB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmVvZiB8fCB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmJyYWNlUiB8fCBfLmxpbmVCcmVhay50ZXN0KHRoaXMuaW5wdXQuc2xpY2UodGhpcy5sYXN0LmVuZCwgdGhpcy50b2suc3RhcnQpKTtcbiAgfTtcblxuICBMb29zZVBhcnNlci5wcm90b3R5cGUuc2VtaWNvbG9uID0gZnVuY3Rpb24gc2VtaWNvbG9uKCkge1xuICAgIHJldHVybiB0aGlzLmVhdChfLnRva1R5cGVzLnNlbWkpO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5leHBlY3QgPSBmdW5jdGlvbiBleHBlY3QodHlwZSkge1xuICAgIGlmICh0aGlzLmVhdCh0eXBlKSkgcmV0dXJuIHRydWU7XG4gICAgZm9yICh2YXIgaSA9IDE7IGkgPD0gMjsgaSsrKSB7XG4gICAgICBpZiAodGhpcy5sb29rQWhlYWQoaSkudHlwZSA9PSB0eXBlKSB7XG4gICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgaTsgaisrKSB7XG4gICAgICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICAgIH1yZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLnB1c2hDeCA9IGZ1bmN0aW9uIHB1c2hDeCgpIHtcbiAgICB0aGlzLmNvbnRleHQucHVzaCh0aGlzLmN1ckluZGVudCk7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLnBvcEN4ID0gZnVuY3Rpb24gcG9wQ3goKSB7XG4gICAgdGhpcy5jdXJJbmRlbnQgPSB0aGlzLmNvbnRleHQucG9wKCk7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLmxpbmVFbmQgPSBmdW5jdGlvbiBsaW5lRW5kKHBvcykge1xuICAgIHdoaWxlIChwb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCAmJiAhXy5pc05ld0xpbmUodGhpcy5pbnB1dC5jaGFyQ29kZUF0KHBvcykpKSArK3BvcztcbiAgICByZXR1cm4gcG9zO1xuICB9O1xuXG4gIExvb3NlUGFyc2VyLnByb3RvdHlwZS5pbmRlbnRhdGlvbkFmdGVyID0gZnVuY3Rpb24gaW5kZW50YXRpb25BZnRlcihwb3MpIHtcbiAgICBmb3IgKHZhciBjb3VudCA9IDA7OyArK3Bvcykge1xuICAgICAgdmFyIGNoID0gdGhpcy5pbnB1dC5jaGFyQ29kZUF0KHBvcyk7XG4gICAgICBpZiAoY2ggPT09IDMyKSArK2NvdW50O2Vsc2UgaWYgKGNoID09PSA5KSBjb3VudCArPSB0aGlzLm9wdGlvbnMudGFiU2l6ZTtlbHNlIHJldHVybiBjb3VudDtcbiAgICB9XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLmNsb3NlcyA9IGZ1bmN0aW9uIGNsb3NlcyhjbG9zZVRvaywgaW5kZW50LCBsaW5lLCBibG9ja0hldXJpc3RpYykge1xuICAgIGlmICh0aGlzLnRvay50eXBlID09PSBjbG9zZVRvayB8fCB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLmVvZikgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIGxpbmUgIT0gdGhpcy5jdXJMaW5lU3RhcnQgJiYgdGhpcy5jdXJJbmRlbnQgPCBpbmRlbnQgJiYgdGhpcy50b2tlblN0YXJ0c0xpbmUoKSAmJiAoIWJsb2NrSGV1cmlzdGljIHx8IHRoaXMubmV4dExpbmVTdGFydCA+PSB0aGlzLmlucHV0Lmxlbmd0aCB8fCB0aGlzLmluZGVudGF0aW9uQWZ0ZXIodGhpcy5uZXh0TGluZVN0YXJ0KSA8IGluZGVudCk7XG4gIH07XG5cbiAgTG9vc2VQYXJzZXIucHJvdG90eXBlLnRva2VuU3RhcnRzTGluZSA9IGZ1bmN0aW9uIHRva2VuU3RhcnRzTGluZSgpIHtcbiAgICBmb3IgKHZhciBwID0gdGhpcy50b2suc3RhcnQgLSAxOyBwID49IHRoaXMuY3VyTGluZVN0YXJ0OyAtLXApIHtcbiAgICAgIHZhciBjaCA9IHRoaXMuaW5wdXQuY2hhckNvZGVBdChwKTtcbiAgICAgIGlmIChjaCAhPT0gOSAmJiBjaCAhPT0gMzIpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH07XG5cbiAgcmV0dXJuIExvb3NlUGFyc2VyO1xufSkoKTtcblxuZXhwb3J0cy5Mb29zZVBhcnNlciA9IExvb3NlUGFyc2VyO1xuXG59LHtcIi4uXCI6Mn1dLDc6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBfc3RhdGUgPSBfZGVyZXFfKFwiLi9zdGF0ZVwiKTtcblxudmFyIF9wYXJzZXV0aWwgPSBfZGVyZXFfKFwiLi9wYXJzZXV0aWxcIik7XG5cbnZhciBfID0gX2RlcmVxXyhcIi4uXCIpO1xuXG52YXIgbHAgPSBfc3RhdGUuTG9vc2VQYXJzZXIucHJvdG90eXBlO1xuXG5scC5wYXJzZVRvcExldmVsID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlQXQodGhpcy5vcHRpb25zLmxvY2F0aW9ucyA/IFswLCBfLmdldExpbmVJbmZvKHRoaXMuaW5wdXQsIDApXSA6IDApO1xuICBub2RlLmJvZHkgPSBbXTtcbiAgd2hpbGUgKHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMuZW9mKSBub2RlLmJvZHkucHVzaCh0aGlzLnBhcnNlU3RhdGVtZW50KCkpO1xuICB0aGlzLmxhc3QgPSB0aGlzLnRvaztcbiAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA2KSB7XG4gICAgbm9kZS5zb3VyY2VUeXBlID0gdGhpcy5vcHRpb25zLnNvdXJjZVR5cGU7XG4gIH1cbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIlByb2dyYW1cIik7XG59O1xuXG5scC5wYXJzZVN0YXRlbWVudCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHN0YXJ0dHlwZSA9IHRoaXMudG9rLnR5cGUsXG4gICAgICBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcblxuICBzd2l0Y2ggKHN0YXJ0dHlwZSkge1xuICAgIGNhc2UgXy50b2tUeXBlcy5fYnJlYWs6Y2FzZSBfLnRva1R5cGVzLl9jb250aW51ZTpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgdmFyIGlzQnJlYWsgPSBzdGFydHR5cGUgPT09IF8udG9rVHlwZXMuX2JyZWFrO1xuICAgICAgaWYgKHRoaXMuc2VtaWNvbG9uKCkgfHwgdGhpcy5jYW5JbnNlcnRTZW1pY29sb24oKSkge1xuICAgICAgICBub2RlLmxhYmVsID0gbnVsbDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5vZGUubGFiZWwgPSB0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLm5hbWUgPyB0aGlzLnBhcnNlSWRlbnQoKSA6IG51bGw7XG4gICAgICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIGlzQnJlYWsgPyBcIkJyZWFrU3RhdGVtZW50XCIgOiBcIkNvbnRpbnVlU3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9kZWJ1Z2dlcjpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgdGhpcy5zZW1pY29sb24oKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJEZWJ1Z2dlclN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fZG86XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoKTtcbiAgICAgIG5vZGUudGVzdCA9IHRoaXMuZWF0KF8udG9rVHlwZXMuX3doaWxlKSA/IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKSA6IHRoaXMuZHVtbXlJZGVudCgpO1xuICAgICAgdGhpcy5zZW1pY29sb24oKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJEb1doaWxlU3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9mb3I6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHRoaXMucHVzaEN4KCk7XG4gICAgICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLnBhcmVuTCk7XG4gICAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5zZW1pKSByZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLCBudWxsKTtcbiAgICAgIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl92YXIgfHwgdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fbGV0IHx8IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX2NvbnN0KSB7XG4gICAgICAgIHZhciBfaW5pdCA9IHRoaXMucGFyc2VWYXIodHJ1ZSk7XG4gICAgICAgIGlmIChfaW5pdC5kZWNsYXJhdGlvbnMubGVuZ3RoID09PSAxICYmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl9pbiB8fCB0aGlzLmlzQ29udGV4dHVhbChcIm9mXCIpKSkge1xuICAgICAgICAgIHJldHVybiB0aGlzLnBhcnNlRm9ySW4obm9kZSwgX2luaXQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLnBhcnNlRm9yKG5vZGUsIF9pbml0KTtcbiAgICAgIH1cbiAgICAgIHZhciBpbml0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24odHJ1ZSk7XG4gICAgICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5faW4gfHwgdGhpcy5pc0NvbnRleHR1YWwoXCJvZlwiKSkgcmV0dXJuIHRoaXMucGFyc2VGb3JJbihub2RlLCB0aGlzLnRvQXNzaWduYWJsZShpbml0KSk7XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUZvcihub2RlLCBpbml0KTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fZnVuY3Rpb246XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRnVuY3Rpb24obm9kZSwgdHJ1ZSk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX2lmOlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBub2RlLnRlc3QgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gICAgICBub2RlLmNvbnNlcXVlbnQgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgICBub2RlLmFsdGVybmF0ZSA9IHRoaXMuZWF0KF8udG9rVHlwZXMuX2Vsc2UpID8gdGhpcy5wYXJzZVN0YXRlbWVudCgpIDogbnVsbDtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJZlN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fcmV0dXJuOlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5zZW1pKSB8fCB0aGlzLmNhbkluc2VydFNlbWljb2xvbigpKSBub2RlLmFyZ3VtZW50ID0gbnVsbDtlbHNlIHtcbiAgICAgICAgbm9kZS5hcmd1bWVudCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7dGhpcy5zZW1pY29sb24oKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJSZXR1cm5TdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3N3aXRjaDpcbiAgICAgIHZhciBibG9ja0luZGVudCA9IHRoaXMuY3VySW5kZW50LFxuICAgICAgICAgIGxpbmUgPSB0aGlzLmN1ckxpbmVTdGFydDtcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgbm9kZS5kaXNjcmltaW5hbnQgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gICAgICBub2RlLmNhc2VzID0gW107XG4gICAgICB0aGlzLnB1c2hDeCgpO1xuICAgICAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5icmFjZUwpO1xuXG4gICAgICB2YXIgY3VyID0gdW5kZWZpbmVkO1xuICAgICAgd2hpbGUgKCF0aGlzLmNsb3NlcyhfLnRva1R5cGVzLmJyYWNlUiwgYmxvY2tJbmRlbnQsIGxpbmUsIHRydWUpKSB7XG4gICAgICAgIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl9jYXNlIHx8IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX2RlZmF1bHQpIHtcbiAgICAgICAgICB2YXIgaXNDYXNlID0gdGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5fY2FzZTtcbiAgICAgICAgICBpZiAoY3VyKSB0aGlzLmZpbmlzaE5vZGUoY3VyLCBcIlN3aXRjaENhc2VcIik7XG4gICAgICAgICAgbm9kZS5jYXNlcy5wdXNoKGN1ciA9IHRoaXMuc3RhcnROb2RlKCkpO1xuICAgICAgICAgIGN1ci5jb25zZXF1ZW50ID0gW107XG4gICAgICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICAgICAgaWYgKGlzQ2FzZSkgY3VyLnRlc3QgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO2Vsc2UgY3VyLnRlc3QgPSBudWxsO1xuICAgICAgICAgIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMuY29sb24pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmICghY3VyKSB7XG4gICAgICAgICAgICBub2RlLmNhc2VzLnB1c2goY3VyID0gdGhpcy5zdGFydE5vZGUoKSk7XG4gICAgICAgICAgICBjdXIuY29uc2VxdWVudCA9IFtdO1xuICAgICAgICAgICAgY3VyLnRlc3QgPSBudWxsO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjdXIuY29uc2VxdWVudC5wdXNoKHRoaXMucGFyc2VTdGF0ZW1lbnQoKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChjdXIpIHRoaXMuZmluaXNoTm9kZShjdXIsIFwiU3dpdGNoQ2FzZVwiKTtcbiAgICAgIHRoaXMucG9wQ3goKTtcbiAgICAgIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VSKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJTd2l0Y2hTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3Rocm93OlxuICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICBub2RlLmFyZ3VtZW50ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVGhyb3dTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3RyeTpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgbm9kZS5ibG9jayA9IHRoaXMucGFyc2VCbG9jaygpO1xuICAgICAgbm9kZS5oYW5kbGVyID0gbnVsbDtcbiAgICAgIGlmICh0aGlzLnRvay50eXBlID09PSBfLnRva1R5cGVzLl9jYXRjaCkge1xuICAgICAgICB2YXIgY2xhdXNlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgICAgdGhpcy5uZXh0KCk7XG4gICAgICAgIHRoaXMuZXhwZWN0KF8udG9rVHlwZXMucGFyZW5MKTtcbiAgICAgICAgY2xhdXNlLnBhcmFtID0gdGhpcy50b0Fzc2lnbmFibGUodGhpcy5wYXJzZUV4cHJBdG9tKCksIHRydWUpO1xuICAgICAgICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLnBhcmVuUik7XG4gICAgICAgIGNsYXVzZS5ndWFyZCA9IG51bGw7XG4gICAgICAgIGNsYXVzZS5ib2R5ID0gdGhpcy5wYXJzZUJsb2NrKCk7XG4gICAgICAgIG5vZGUuaGFuZGxlciA9IHRoaXMuZmluaXNoTm9kZShjbGF1c2UsIFwiQ2F0Y2hDbGF1c2VcIik7XG4gICAgICB9XG4gICAgICBub2RlLmZpbmFsaXplciA9IHRoaXMuZWF0KF8udG9rVHlwZXMuX2ZpbmFsbHkpID8gdGhpcy5wYXJzZUJsb2NrKCkgOiBudWxsO1xuICAgICAgaWYgKCFub2RlLmhhbmRsZXIgJiYgIW5vZGUuZmluYWxpemVyKSByZXR1cm4gbm9kZS5ibG9jaztcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJUcnlTdGF0ZW1lbnRcIik7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX3ZhcjpcbiAgICBjYXNlIF8udG9rVHlwZXMuX2xldDpcbiAgICBjYXNlIF8udG9rVHlwZXMuX2NvbnN0OlxuICAgICAgcmV0dXJuIHRoaXMucGFyc2VWYXIoKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fd2hpbGU6XG4gICAgICB0aGlzLm5leHQoKTtcbiAgICAgIG5vZGUudGVzdCA9IHRoaXMucGFyc2VQYXJlbkV4cHJlc3Npb24oKTtcbiAgICAgIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoKTtcbiAgICAgIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJXaGlsZVN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5fd2l0aDpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgbm9kZS5vYmplY3QgPSB0aGlzLnBhcnNlUGFyZW5FeHByZXNzaW9uKCk7XG4gICAgICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiV2l0aFN0YXRlbWVudFwiKTtcblxuICAgIGNhc2UgXy50b2tUeXBlcy5icmFjZUw6XG4gICAgICByZXR1cm4gdGhpcy5wYXJzZUJsb2NrKCk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuc2VtaTpcbiAgICAgIHRoaXMubmV4dCgpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkVtcHR5U3RhdGVtZW50XCIpO1xuXG4gICAgY2FzZSBfLnRva1R5cGVzLl9jbGFzczpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlQ2xhc3ModHJ1ZSk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX2ltcG9ydDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlSW1wb3J0KCk7XG5cbiAgICBjYXNlIF8udG9rVHlwZXMuX2V4cG9ydDpcbiAgICAgIHJldHVybiB0aGlzLnBhcnNlRXhwb3J0KCk7XG5cbiAgICBkZWZhdWx0OlxuICAgICAgdmFyIGV4cHIgPSB0aGlzLnBhcnNlRXhwcmVzc2lvbigpO1xuICAgICAgaWYgKF9wYXJzZXV0aWwuaXNEdW1teShleHByKSkge1xuICAgICAgICB0aGlzLm5leHQoKTtcbiAgICAgICAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuZW9mKSByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRW1wdHlTdGF0ZW1lbnRcIik7XG4gICAgICAgIHJldHVybiB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gICAgICB9IGVsc2UgaWYgKHN0YXJ0dHlwZSA9PT0gXy50b2tUeXBlcy5uYW1lICYmIGV4cHIudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgdGhpcy5lYXQoXy50b2tUeXBlcy5jb2xvbikpIHtcbiAgICAgICAgbm9kZS5ib2R5ID0gdGhpcy5wYXJzZVN0YXRlbWVudCgpO1xuICAgICAgICBub2RlLmxhYmVsID0gZXhwcjtcbiAgICAgICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkxhYmVsZWRTdGF0ZW1lbnRcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBub2RlLmV4cHJlc3Npb24gPSBleHByO1xuICAgICAgICB0aGlzLnNlbWljb2xvbigpO1xuICAgICAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwcmVzc2lvblN0YXRlbWVudFwiKTtcbiAgICAgIH1cbiAgfVxufTtcblxubHAucGFyc2VCbG9jayA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLnB1c2hDeCgpO1xuICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLmJyYWNlTCk7XG4gIHZhciBibG9ja0luZGVudCA9IHRoaXMuY3VySW5kZW50LFxuICAgICAgbGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICBub2RlLmJvZHkgPSBbXTtcbiAgd2hpbGUgKCF0aGlzLmNsb3NlcyhfLnRva1R5cGVzLmJyYWNlUiwgYmxvY2tJbmRlbnQsIGxpbmUsIHRydWUpKSBub2RlLmJvZHkucHVzaCh0aGlzLnBhcnNlU3RhdGVtZW50KCkpO1xuICB0aGlzLnBvcEN4KCk7XG4gIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VSKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkJsb2NrU3RhdGVtZW50XCIpO1xufTtcblxubHAucGFyc2VGb3IgPSBmdW5jdGlvbiAobm9kZSwgaW5pdCkge1xuICBub2RlLmluaXQgPSBpbml0O1xuICBub2RlLnRlc3QgPSBub2RlLnVwZGF0ZSA9IG51bGw7XG4gIGlmICh0aGlzLmVhdChfLnRva1R5cGVzLnNlbWkpICYmIHRoaXMudG9rLnR5cGUgIT09IF8udG9rVHlwZXMuc2VtaSkgbm9kZS50ZXN0ID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuc2VtaSkgJiYgdGhpcy50b2sudHlwZSAhPT0gXy50b2tUeXBlcy5wYXJlblIpIG5vZGUudXBkYXRlID0gdGhpcy5wYXJzZUV4cHJlc3Npb24oKTtcbiAgdGhpcy5wb3BDeCgpO1xuICB0aGlzLmV4cGVjdChfLnRva1R5cGVzLnBhcmVuUik7XG4gIG5vZGUuYm9keSA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkZvclN0YXRlbWVudFwiKTtcbn07XG5cbmxwLnBhcnNlRm9ySW4gPSBmdW5jdGlvbiAobm9kZSwgaW5pdCkge1xuICB2YXIgdHlwZSA9IHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuX2luID8gXCJGb3JJblN0YXRlbWVudFwiIDogXCJGb3JPZlN0YXRlbWVudFwiO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5sZWZ0ID0gaW5pdDtcbiAgbm9kZS5yaWdodCA9IHRoaXMucGFyc2VFeHByZXNzaW9uKCk7XG4gIHRoaXMucG9wQ3goKTtcbiAgdGhpcy5leHBlY3QoXy50b2tUeXBlcy5wYXJlblIpO1xuICBub2RlLmJvZHkgPSB0aGlzLnBhcnNlU3RhdGVtZW50KCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgdHlwZSk7XG59O1xuXG5scC5wYXJzZVZhciA9IGZ1bmN0aW9uIChub0luKSB7XG4gIHZhciBub2RlID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgbm9kZS5raW5kID0gdGhpcy50b2sudHlwZS5rZXl3b3JkO1xuICB0aGlzLm5leHQoKTtcbiAgbm9kZS5kZWNsYXJhdGlvbnMgPSBbXTtcbiAgZG8ge1xuICAgIHZhciBkZWNsID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICBkZWNsLmlkID0gdGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYgPyB0aGlzLnRvQXNzaWduYWJsZSh0aGlzLnBhcnNlRXhwckF0b20oKSwgdHJ1ZSkgOiB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgICBkZWNsLmluaXQgPSB0aGlzLmVhdChfLnRva1R5cGVzLmVxKSA/IHRoaXMucGFyc2VNYXliZUFzc2lnbihub0luKSA6IG51bGw7XG4gICAgbm9kZS5kZWNsYXJhdGlvbnMucHVzaCh0aGlzLmZpbmlzaE5vZGUoZGVjbCwgXCJWYXJpYWJsZURlY2xhcmF0b3JcIikpO1xuICB9IHdoaWxlICh0aGlzLmVhdChfLnRva1R5cGVzLmNvbW1hKSk7XG4gIGlmICghbm9kZS5kZWNsYXJhdGlvbnMubGVuZ3RoKSB7XG4gICAgdmFyIGRlY2wgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIGRlY2wuaWQgPSB0aGlzLmR1bW15SWRlbnQoKTtcbiAgICBub2RlLmRlY2xhcmF0aW9ucy5wdXNoKHRoaXMuZmluaXNoTm9kZShkZWNsLCBcIlZhcmlhYmxlRGVjbGFyYXRvclwiKSk7XG4gIH1cbiAgaWYgKCFub0luKSB0aGlzLnNlbWljb2xvbigpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiVmFyaWFibGVEZWNsYXJhdGlvblwiKTtcbn07XG5cbmxwLnBhcnNlQ2xhc3MgPSBmdW5jdGlvbiAoaXNTdGF0ZW1lbnQpIHtcbiAgdmFyIG5vZGUgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICB0aGlzLm5leHQoKTtcbiAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMubmFtZSkgbm9kZS5pZCA9IHRoaXMucGFyc2VJZGVudCgpO2Vsc2UgaWYgKGlzU3RhdGVtZW50KSBub2RlLmlkID0gdGhpcy5kdW1teUlkZW50KCk7ZWxzZSBub2RlLmlkID0gbnVsbDtcbiAgbm9kZS5zdXBlckNsYXNzID0gdGhpcy5lYXQoXy50b2tUeXBlcy5fZXh0ZW5kcykgPyB0aGlzLnBhcnNlRXhwcmVzc2lvbigpIDogbnVsbDtcbiAgbm9kZS5ib2R5ID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgbm9kZS5ib2R5LmJvZHkgPSBbXTtcbiAgdGhpcy5wdXNoQ3goKTtcbiAgdmFyIGluZGVudCA9IHRoaXMuY3VySW5kZW50ICsgMSxcbiAgICAgIGxpbmUgPSB0aGlzLmN1ckxpbmVTdGFydDtcbiAgdGhpcy5lYXQoXy50b2tUeXBlcy5icmFjZUwpO1xuICBpZiAodGhpcy5jdXJJbmRlbnQgKyAxIDwgaW5kZW50KSB7XG4gICAgaW5kZW50ID0gdGhpcy5jdXJJbmRlbnQ7bGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICB9XG4gIHdoaWxlICghdGhpcy5jbG9zZXMoXy50b2tUeXBlcy5icmFjZVIsIGluZGVudCwgbGluZSkpIHtcbiAgICBpZiAodGhpcy5zZW1pY29sb24oKSkgY29udGludWU7XG4gICAgdmFyIG1ldGhvZCA9IHRoaXMuc3RhcnROb2RlKCksXG4gICAgICAgIGlzR2VuZXJhdG9yID0gdW5kZWZpbmVkO1xuICAgIGlmICh0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgICAgbWV0aG9kW1wic3RhdGljXCJdID0gZmFsc2U7XG4gICAgICBpc0dlbmVyYXRvciA9IHRoaXMuZWF0KF8udG9rVHlwZXMuc3Rhcik7XG4gICAgfVxuICAgIHRoaXMucGFyc2VQcm9wZXJ0eU5hbWUobWV0aG9kKTtcbiAgICBpZiAoX3BhcnNldXRpbC5pc0R1bW15KG1ldGhvZC5rZXkpKSB7XG4gICAgICBpZiAoX3BhcnNldXRpbC5pc0R1bW15KHRoaXMucGFyc2VNYXliZUFzc2lnbigpKSkgdGhpcy5uZXh0KCk7dGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSk7Y29udGludWU7XG4gICAgfVxuICAgIGlmIChtZXRob2Qua2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmICFtZXRob2QuY29tcHV0ZWQgJiYgbWV0aG9kLmtleS5uYW1lID09PSBcInN0YXRpY1wiICYmICh0aGlzLnRvay50eXBlICE9IF8udG9rVHlwZXMucGFyZW5MICYmIHRoaXMudG9rLnR5cGUgIT0gXy50b2tUeXBlcy5icmFjZUwpKSB7XG4gICAgICBtZXRob2RbXCJzdGF0aWNcIl0gPSB0cnVlO1xuICAgICAgaXNHZW5lcmF0b3IgPSB0aGlzLmVhdChfLnRva1R5cGVzLnN0YXIpO1xuICAgICAgdGhpcy5wYXJzZVByb3BlcnR5TmFtZShtZXRob2QpO1xuICAgIH0gZWxzZSB7XG4gICAgICBtZXRob2RbXCJzdGF0aWNcIl0gPSBmYWxzZTtcbiAgICB9XG4gICAgaWYgKHRoaXMub3B0aW9ucy5lY21hVmVyc2lvbiA+PSA1ICYmIG1ldGhvZC5rZXkudHlwZSA9PT0gXCJJZGVudGlmaWVyXCIgJiYgIW1ldGhvZC5jb21wdXRlZCAmJiAobWV0aG9kLmtleS5uYW1lID09PSBcImdldFwiIHx8IG1ldGhvZC5rZXkubmFtZSA9PT0gXCJzZXRcIikgJiYgdGhpcy50b2sudHlwZSAhPT0gXy50b2tUeXBlcy5wYXJlbkwgJiYgdGhpcy50b2sudHlwZSAhPT0gXy50b2tUeXBlcy5icmFjZUwpIHtcbiAgICAgIG1ldGhvZC5raW5kID0gbWV0aG9kLmtleS5uYW1lO1xuICAgICAgdGhpcy5wYXJzZVByb3BlcnR5TmFtZShtZXRob2QpO1xuICAgICAgbWV0aG9kLnZhbHVlID0gdGhpcy5wYXJzZU1ldGhvZChmYWxzZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICghbWV0aG9kLmNvbXB1dGVkICYmICFtZXRob2RbXCJzdGF0aWNcIl0gJiYgIWlzR2VuZXJhdG9yICYmIChtZXRob2Qua2V5LnR5cGUgPT09IFwiSWRlbnRpZmllclwiICYmIG1ldGhvZC5rZXkubmFtZSA9PT0gXCJjb25zdHJ1Y3RvclwiIHx8IG1ldGhvZC5rZXkudHlwZSA9PT0gXCJMaXRlcmFsXCIgJiYgbWV0aG9kLmtleS52YWx1ZSA9PT0gXCJjb25zdHJ1Y3RvclwiKSkge1xuICAgICAgICBtZXRob2Qua2luZCA9IFwiY29uc3RydWN0b3JcIjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1ldGhvZC5raW5kID0gXCJtZXRob2RcIjtcbiAgICAgIH1cbiAgICAgIG1ldGhvZC52YWx1ZSA9IHRoaXMucGFyc2VNZXRob2QoaXNHZW5lcmF0b3IpO1xuICAgIH1cbiAgICBub2RlLmJvZHkuYm9keS5wdXNoKHRoaXMuZmluaXNoTm9kZShtZXRob2QsIFwiTWV0aG9kRGVmaW5pdGlvblwiKSk7XG4gIH1cbiAgdGhpcy5wb3BDeCgpO1xuICBpZiAoIXRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VSKSkge1xuICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsb3NpbmcgYnJhY2UsIG1ha2UgdGhlIG5vZGUgc3BhbiB0byB0aGUgc3RhcnRcbiAgICAvLyBvZiB0aGUgbmV4dCB0b2tlbiAodGhpcyBpcyB1c2VmdWwgZm9yIFRlcm4pXG4gICAgdGhpcy5sYXN0LmVuZCA9IHRoaXMudG9rLnN0YXJ0O1xuICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB0aGlzLmxhc3QubG9jLmVuZCA9IHRoaXMudG9rLmxvYy5zdGFydDtcbiAgfVxuICB0aGlzLnNlbWljb2xvbigpO1xuICB0aGlzLmZpbmlzaE5vZGUobm9kZS5ib2R5LCBcIkNsYXNzQm9keVwiKTtcbiAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBpc1N0YXRlbWVudCA/IFwiQ2xhc3NEZWNsYXJhdGlvblwiIDogXCJDbGFzc0V4cHJlc3Npb25cIik7XG59O1xuXG5scC5wYXJzZUZ1bmN0aW9uID0gZnVuY3Rpb24gKG5vZGUsIGlzU3RhdGVtZW50KSB7XG4gIHRoaXMuaW5pdEZ1bmN0aW9uKG5vZGUpO1xuICBpZiAodGhpcy5vcHRpb25zLmVjbWFWZXJzaW9uID49IDYpIHtcbiAgICBub2RlLmdlbmVyYXRvciA9IHRoaXMuZWF0KF8udG9rVHlwZXMuc3Rhcik7XG4gIH1cbiAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMubmFtZSkgbm9kZS5pZCA9IHRoaXMucGFyc2VJZGVudCgpO2Vsc2UgaWYgKGlzU3RhdGVtZW50KSBub2RlLmlkID0gdGhpcy5kdW1teUlkZW50KCk7XG4gIG5vZGUucGFyYW1zID0gdGhpcy5wYXJzZUZ1bmN0aW9uUGFyYW1zKCk7XG4gIG5vZGUuYm9keSA9IHRoaXMucGFyc2VCbG9jaygpO1xuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIGlzU3RhdGVtZW50ID8gXCJGdW5jdGlvbkRlY2xhcmF0aW9uXCIgOiBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiKTtcbn07XG5cbmxwLnBhcnNlRXhwb3J0ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMubmV4dCgpO1xuICBpZiAodGhpcy5lYXQoXy50b2tUeXBlcy5zdGFyKSkge1xuICAgIG5vZGUuc291cmNlID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiZnJvbVwiKSA/IHRoaXMucGFyc2VFeHByQXRvbSgpIDogbnVsbDtcbiAgICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwb3J0QWxsRGVjbGFyYXRpb25cIik7XG4gIH1cbiAgaWYgKHRoaXMuZWF0KF8udG9rVHlwZXMuX2RlZmF1bHQpKSB7XG4gICAgdmFyIGV4cHIgPSB0aGlzLnBhcnNlTWF5YmVBc3NpZ24oKTtcbiAgICBpZiAoZXhwci5pZCkge1xuICAgICAgc3dpdGNoIChleHByLnR5cGUpIHtcbiAgICAgICAgY2FzZSBcIkZ1bmN0aW9uRXhwcmVzc2lvblwiOlxuICAgICAgICAgIGV4cHIudHlwZSA9IFwiRnVuY3Rpb25EZWNsYXJhdGlvblwiO2JyZWFrO1xuICAgICAgICBjYXNlIFwiQ2xhc3NFeHByZXNzaW9uXCI6XG4gICAgICAgICAgZXhwci50eXBlID0gXCJDbGFzc0RlY2xhcmF0aW9uXCI7YnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIG5vZGUuZGVjbGFyYXRpb24gPSBleHByO1xuICAgIHRoaXMuc2VtaWNvbG9uKCk7XG4gICAgcmV0dXJuIHRoaXMuZmluaXNoTm9kZShub2RlLCBcIkV4cG9ydERlZmF1bHREZWNsYXJhdGlvblwiKTtcbiAgfVxuICBpZiAodGhpcy50b2sudHlwZS5rZXl3b3JkKSB7XG4gICAgbm9kZS5kZWNsYXJhdGlvbiA9IHRoaXMucGFyc2VTdGF0ZW1lbnQoKTtcbiAgICBub2RlLnNwZWNpZmllcnMgPSBbXTtcbiAgICBub2RlLnNvdXJjZSA9IG51bGw7XG4gIH0gZWxzZSB7XG4gICAgbm9kZS5kZWNsYXJhdGlvbiA9IG51bGw7XG4gICAgbm9kZS5zcGVjaWZpZXJzID0gdGhpcy5wYXJzZUV4cG9ydFNwZWNpZmllckxpc3QoKTtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMuZWF0Q29udGV4dHVhbChcImZyb21cIikgPyB0aGlzLnBhcnNlRXhwckF0b20oKSA6IG51bGw7XG4gICAgdGhpcy5zZW1pY29sb24oKTtcbiAgfVxuICByZXR1cm4gdGhpcy5maW5pc2hOb2RlKG5vZGUsIFwiRXhwb3J0TmFtZWREZWNsYXJhdGlvblwiKTtcbn07XG5cbmxwLnBhcnNlSW1wb3J0ID0gZnVuY3Rpb24gKCkge1xuICB2YXIgbm9kZSA9IHRoaXMuc3RhcnROb2RlKCk7XG4gIHRoaXMubmV4dCgpO1xuICBpZiAodGhpcy50b2sudHlwZSA9PT0gXy50b2tUeXBlcy5zdHJpbmcpIHtcbiAgICBub2RlLnNwZWNpZmllcnMgPSBbXTtcbiAgICBub2RlLnNvdXJjZSA9IHRoaXMucGFyc2VFeHByQXRvbSgpO1xuICAgIG5vZGUua2luZCA9ICcnO1xuICB9IGVsc2Uge1xuICAgIHZhciBlbHQgPSB1bmRlZmluZWQ7XG4gICAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMubmFtZSAmJiB0aGlzLnRvay52YWx1ZSAhPT0gXCJmcm9tXCIpIHtcbiAgICAgIGVsdCA9IHRoaXMuc3RhcnROb2RlKCk7XG4gICAgICBlbHQubG9jYWwgPSB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgICAgIHRoaXMuZmluaXNoTm9kZShlbHQsIFwiSW1wb3J0RGVmYXVsdFNwZWNpZmllclwiKTtcbiAgICAgIHRoaXMuZWF0KF8udG9rVHlwZXMuY29tbWEpO1xuICAgIH1cbiAgICBub2RlLnNwZWNpZmllcnMgPSB0aGlzLnBhcnNlSW1wb3J0U3BlY2lmaWVyTGlzdCgpO1xuICAgIG5vZGUuc291cmNlID0gdGhpcy5lYXRDb250ZXh0dWFsKFwiZnJvbVwiKSA/IHRoaXMucGFyc2VFeHByQXRvbSgpIDogbnVsbDtcbiAgICBpZiAoZWx0KSBub2RlLnNwZWNpZmllcnMudW5zaGlmdChlbHQpO1xuICB9XG4gIHRoaXMuc2VtaWNvbG9uKCk7XG4gIHJldHVybiB0aGlzLmZpbmlzaE5vZGUobm9kZSwgXCJJbXBvcnREZWNsYXJhdGlvblwiKTtcbn07XG5cbmxwLnBhcnNlSW1wb3J0U3BlY2lmaWVyTGlzdCA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIGVsdHMgPSBbXTtcbiAgaWYgKHRoaXMudG9rLnR5cGUgPT09IF8udG9rVHlwZXMuc3Rhcikge1xuICAgIHZhciBlbHQgPSB0aGlzLnN0YXJ0Tm9kZSgpO1xuICAgIHRoaXMubmV4dCgpO1xuICAgIGlmICh0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKSkgZWx0LmxvY2FsID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgZWx0cy5wdXNoKHRoaXMuZmluaXNoTm9kZShlbHQsIFwiSW1wb3J0TmFtZXNwYWNlU3BlY2lmaWVyXCIpKTtcbiAgfSBlbHNlIHtcbiAgICB2YXIgaW5kZW50ID0gdGhpcy5jdXJJbmRlbnQsXG4gICAgICAgIGxpbmUgPSB0aGlzLmN1ckxpbmVTdGFydCxcbiAgICAgICAgY29udGludWVkTGluZSA9IHRoaXMubmV4dExpbmVTdGFydDtcbiAgICB0aGlzLnB1c2hDeCgpO1xuICAgIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VMKTtcbiAgICBpZiAodGhpcy5jdXJMaW5lU3RhcnQgPiBjb250aW51ZWRMaW5lKSBjb250aW51ZWRMaW5lID0gdGhpcy5jdXJMaW5lU3RhcnQ7XG4gICAgd2hpbGUgKCF0aGlzLmNsb3NlcyhfLnRva1R5cGVzLmJyYWNlUiwgaW5kZW50ICsgKHRoaXMuY3VyTGluZVN0YXJ0IDw9IGNvbnRpbnVlZExpbmUgPyAxIDogMCksIGxpbmUpKSB7XG4gICAgICB2YXIgZWx0ID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICAgIGlmICh0aGlzLmVhdChfLnRva1R5cGVzLnN0YXIpKSB7XG4gICAgICAgIGlmICh0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKSkgZWx0LmxvY2FsID0gdGhpcy5wYXJzZUlkZW50KCk7XG4gICAgICAgIHRoaXMuZmluaXNoTm9kZShlbHQsIFwiSW1wb3J0TmFtZXNwYWNlU3BlY2lmaWVyXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKHRoaXMuaXNDb250ZXh0dWFsKFwiZnJvbVwiKSkgYnJlYWs7XG4gICAgICAgIGVsdC5pbXBvcnRlZCA9IHRoaXMucGFyc2VJZGVudCgpO1xuICAgICAgICBpZiAoX3BhcnNldXRpbC5pc0R1bW15KGVsdC5pbXBvcnRlZCkpIGJyZWFrO1xuICAgICAgICBlbHQubG9jYWwgPSB0aGlzLmVhdENvbnRleHR1YWwoXCJhc1wiKSA/IHRoaXMucGFyc2VJZGVudCgpIDogZWx0LmltcG9ydGVkO1xuICAgICAgICB0aGlzLmZpbmlzaE5vZGUoZWx0LCBcIkltcG9ydFNwZWNpZmllclwiKTtcbiAgICAgIH1cbiAgICAgIGVsdHMucHVzaChlbHQpO1xuICAgICAgdGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSk7XG4gICAgfVxuICAgIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VSKTtcbiAgICB0aGlzLnBvcEN4KCk7XG4gIH1cbiAgcmV0dXJuIGVsdHM7XG59O1xuXG5scC5wYXJzZUV4cG9ydFNwZWNpZmllckxpc3QgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBlbHRzID0gW107XG4gIHZhciBpbmRlbnQgPSB0aGlzLmN1ckluZGVudCxcbiAgICAgIGxpbmUgPSB0aGlzLmN1ckxpbmVTdGFydCxcbiAgICAgIGNvbnRpbnVlZExpbmUgPSB0aGlzLm5leHRMaW5lU3RhcnQ7XG4gIHRoaXMucHVzaEN4KCk7XG4gIHRoaXMuZWF0KF8udG9rVHlwZXMuYnJhY2VMKTtcbiAgaWYgKHRoaXMuY3VyTGluZVN0YXJ0ID4gY29udGludWVkTGluZSkgY29udGludWVkTGluZSA9IHRoaXMuY3VyTGluZVN0YXJ0O1xuICB3aGlsZSAoIXRoaXMuY2xvc2VzKF8udG9rVHlwZXMuYnJhY2VSLCBpbmRlbnQgKyAodGhpcy5jdXJMaW5lU3RhcnQgPD0gY29udGludWVkTGluZSA/IDEgOiAwKSwgbGluZSkpIHtcbiAgICBpZiAodGhpcy5pc0NvbnRleHR1YWwoXCJmcm9tXCIpKSBicmVhaztcbiAgICB2YXIgZWx0ID0gdGhpcy5zdGFydE5vZGUoKTtcbiAgICBlbHQubG9jYWwgPSB0aGlzLnBhcnNlSWRlbnQoKTtcbiAgICBpZiAoX3BhcnNldXRpbC5pc0R1bW15KGVsdC5sb2NhbCkpIGJyZWFrO1xuICAgIGVsdC5leHBvcnRlZCA9IHRoaXMuZWF0Q29udGV4dHVhbChcImFzXCIpID8gdGhpcy5wYXJzZUlkZW50KCkgOiBlbHQubG9jYWw7XG4gICAgdGhpcy5maW5pc2hOb2RlKGVsdCwgXCJFeHBvcnRTcGVjaWZpZXJcIik7XG4gICAgZWx0cy5wdXNoKGVsdCk7XG4gICAgdGhpcy5lYXQoXy50b2tUeXBlcy5jb21tYSk7XG4gIH1cbiAgdGhpcy5lYXQoXy50b2tUeXBlcy5icmFjZVIpO1xuICB0aGlzLnBvcEN4KCk7XG4gIHJldHVybiBlbHRzO1xufTtcblxufSx7XCIuLlwiOjIsXCIuL3BhcnNldXRpbFwiOjUsXCIuL3N0YXRlXCI6Nn1dLDg6W2Z1bmN0aW9uKF9kZXJlcV8sbW9kdWxlLGV4cG9ydHMpe1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbnZhciBfID0gX2RlcmVxXyhcIi4uXCIpO1xuXG52YXIgX3N0YXRlID0gX2RlcmVxXyhcIi4vc3RhdGVcIik7XG5cbnZhciBscCA9IF9zdGF0ZS5Mb29zZVBhcnNlci5wcm90b3R5cGU7XG5cbmZ1bmN0aW9uIGlzU3BhY2UoY2gpIHtcbiAgcmV0dXJuIGNoIDwgMTQgJiYgY2ggPiA4IHx8IGNoID09PSAzMiB8fCBjaCA9PT0gMTYwIHx8IF8uaXNOZXdMaW5lKGNoKTtcbn1cblxubHAubmV4dCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5sYXN0ID0gdGhpcy50b2s7XG4gIGlmICh0aGlzLmFoZWFkLmxlbmd0aCkgdGhpcy50b2sgPSB0aGlzLmFoZWFkLnNoaWZ0KCk7ZWxzZSB0aGlzLnRvayA9IHRoaXMucmVhZFRva2VuKCk7XG5cbiAgaWYgKHRoaXMudG9rLnN0YXJ0ID49IHRoaXMubmV4dExpbmVTdGFydCkge1xuICAgIHdoaWxlICh0aGlzLnRvay5zdGFydCA+PSB0aGlzLm5leHRMaW5lU3RhcnQpIHtcbiAgICAgIHRoaXMuY3VyTGluZVN0YXJ0ID0gdGhpcy5uZXh0TGluZVN0YXJ0O1xuICAgICAgdGhpcy5uZXh0TGluZVN0YXJ0ID0gdGhpcy5saW5lRW5kKHRoaXMuY3VyTGluZVN0YXJ0KSArIDE7XG4gICAgfVxuICAgIHRoaXMuY3VySW5kZW50ID0gdGhpcy5pbmRlbnRhdGlvbkFmdGVyKHRoaXMuY3VyTGluZVN0YXJ0KTtcbiAgfVxufTtcblxubHAucmVhZFRva2VuID0gZnVuY3Rpb24gKCkge1xuICBmb3IgKDs7KSB7XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMudG9rcy5uZXh0KCk7XG4gICAgICBpZiAodGhpcy50b2tzLnR5cGUgPT09IF8udG9rVHlwZXMuZG90ICYmIHRoaXMuaW5wdXQuc3Vic3RyKHRoaXMudG9rcy5lbmQsIDEpID09PSBcIi5cIiAmJiB0aGlzLm9wdGlvbnMuZWNtYVZlcnNpb24gPj0gNikge1xuICAgICAgICB0aGlzLnRva3MuZW5kKys7XG4gICAgICAgIHRoaXMudG9rcy50eXBlID0gXy50b2tUeXBlcy5lbGxpcHNpcztcbiAgICAgIH1cbiAgICAgIHJldHVybiBuZXcgXy5Ub2tlbih0aGlzLnRva3MpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmICghKGUgaW5zdGFuY2VvZiBTeW50YXhFcnJvcikpIHRocm93IGU7XG5cbiAgICAgIC8vIFRyeSB0byBza2lwIHNvbWUgdGV4dCwgYmFzZWQgb24gdGhlIGVycm9yIG1lc3NhZ2UsIGFuZCB0aGVuIGNvbnRpbnVlXG4gICAgICB2YXIgbXNnID0gZS5tZXNzYWdlLFxuICAgICAgICAgIHBvcyA9IGUucmFpc2VkQXQsXG4gICAgICAgICAgcmVwbGFjZSA9IHRydWU7XG4gICAgICBpZiAoL3VudGVybWluYXRlZC9pLnRlc3QobXNnKSkge1xuICAgICAgICBwb3MgPSB0aGlzLmxpbmVFbmQoZS5wb3MgKyAxKTtcbiAgICAgICAgaWYgKC9zdHJpbmcvLnRlc3QobXNnKSkge1xuICAgICAgICAgIHJlcGxhY2UgPSB7IHN0YXJ0OiBlLnBvcywgZW5kOiBwb3MsIHR5cGU6IF8udG9rVHlwZXMuc3RyaW5nLCB2YWx1ZTogdGhpcy5pbnB1dC5zbGljZShlLnBvcyArIDEsIHBvcykgfTtcbiAgICAgICAgfSBlbHNlIGlmICgvcmVndWxhciBleHByL2kudGVzdChtc2cpKSB7XG4gICAgICAgICAgdmFyIHJlID0gdGhpcy5pbnB1dC5zbGljZShlLnBvcywgcG9zKTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmUgPSBuZXcgUmVnRXhwKHJlKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7fVxuICAgICAgICAgIHJlcGxhY2UgPSB7IHN0YXJ0OiBlLnBvcywgZW5kOiBwb3MsIHR5cGU6IF8udG9rVHlwZXMucmVnZXhwLCB2YWx1ZTogcmUgfTtcbiAgICAgICAgfSBlbHNlIGlmICgvdGVtcGxhdGUvLnRlc3QobXNnKSkge1xuICAgICAgICAgIHJlcGxhY2UgPSB7IHN0YXJ0OiBlLnBvcywgZW5kOiBwb3MsXG4gICAgICAgICAgICB0eXBlOiBfLnRva1R5cGVzLnRlbXBsYXRlLFxuICAgICAgICAgICAgdmFsdWU6IHRoaXMuaW5wdXQuc2xpY2UoZS5wb3MsIHBvcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXBsYWNlID0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoL2ludmFsaWQgKHVuaWNvZGV8cmVnZXhwfG51bWJlcil8ZXhwZWN0aW5nIHVuaWNvZGV8b2N0YWwgbGl0ZXJhbHxpcyByZXNlcnZlZHxkaXJlY3RseSBhZnRlciBudW1iZXJ8ZXhwZWN0ZWQgbnVtYmVyIGluIHJhZGl4L2kudGVzdChtc2cpKSB7XG4gICAgICAgIHdoaWxlIChwb3MgPCB0aGlzLmlucHV0Lmxlbmd0aCAmJiAhaXNTcGFjZSh0aGlzLmlucHV0LmNoYXJDb2RlQXQocG9zKSkpICsrcG9zO1xuICAgICAgfSBlbHNlIGlmICgvY2hhcmFjdGVyIGVzY2FwZXxleHBlY3RlZCBoZXhhZGVjaW1hbC9pLnRlc3QobXNnKSkge1xuICAgICAgICB3aGlsZSAocG9zIDwgdGhpcy5pbnB1dC5sZW5ndGgpIHtcbiAgICAgICAgICB2YXIgY2ggPSB0aGlzLmlucHV0LmNoYXJDb2RlQXQocG9zKyspO1xuICAgICAgICAgIGlmIChjaCA9PT0gMzQgfHwgY2ggPT09IDM5IHx8IF8uaXNOZXdMaW5lKGNoKSkgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoL3VuZXhwZWN0ZWQgY2hhcmFjdGVyL2kudGVzdChtc2cpKSB7XG4gICAgICAgIHBvcysrO1xuICAgICAgICByZXBsYWNlID0gZmFsc2U7XG4gICAgICB9IGVsc2UgaWYgKC9yZWd1bGFyIGV4cHJlc3Npb24vaS50ZXN0KG1zZykpIHtcbiAgICAgICAgcmVwbGFjZSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgICAgdGhpcy5yZXNldFRvKHBvcyk7XG4gICAgICBpZiAocmVwbGFjZSA9PT0gdHJ1ZSkgcmVwbGFjZSA9IHsgc3RhcnQ6IHBvcywgZW5kOiBwb3MsIHR5cGU6IF8udG9rVHlwZXMubmFtZSwgdmFsdWU6IFwi4pyWXCIgfTtcbiAgICAgIGlmIChyZXBsYWNlKSB7XG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSByZXBsYWNlLmxvYyA9IG5ldyBfLlNvdXJjZUxvY2F0aW9uKHRoaXMudG9rcywgXy5nZXRMaW5lSW5mbyh0aGlzLmlucHV0LCByZXBsYWNlLnN0YXJ0KSwgXy5nZXRMaW5lSW5mbyh0aGlzLmlucHV0LCByZXBsYWNlLmVuZCkpO1xuICAgICAgICByZXR1cm4gcmVwbGFjZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbmxwLnJlc2V0VG8gPSBmdW5jdGlvbiAocG9zKSB7XG4gIHRoaXMudG9rcy5wb3MgPSBwb3M7XG4gIHZhciBjaCA9IHRoaXMuaW5wdXQuY2hhckF0KHBvcyAtIDEpO1xuICB0aGlzLnRva3MuZXhwckFsbG93ZWQgPSAhY2ggfHwgL1tcXFtcXHtcXCgsOzo/XFwvKj0rXFwtfiF8JiVePD5dLy50ZXN0KGNoKSB8fCAvW2Vud2ZkXS8udGVzdChjaCkgJiYgL1xcYihrZXl3b3Jkc3xjYXNlfGVsc2V8cmV0dXJufHRocm93fG5ld3xpbnwoaW5zdGFuY2V8dHlwZSlvZnxkZWxldGV8dm9pZCkkLy50ZXN0KHRoaXMuaW5wdXQuc2xpY2UocG9zIC0gMTAsIHBvcykpO1xuXG4gIGlmICh0aGlzLm9wdGlvbnMubG9jYXRpb25zKSB7XG4gICAgdGhpcy50b2tzLmN1ckxpbmUgPSAxO1xuICAgIHRoaXMudG9rcy5saW5lU3RhcnQgPSBfLmxpbmVCcmVha0cubGFzdEluZGV4ID0gMDtcbiAgICB2YXIgbWF0Y2ggPSB1bmRlZmluZWQ7XG4gICAgd2hpbGUgKChtYXRjaCA9IF8ubGluZUJyZWFrRy5leGVjKHRoaXMuaW5wdXQpKSAmJiBtYXRjaC5pbmRleCA8IHBvcykge1xuICAgICAgKyt0aGlzLnRva3MuY3VyTGluZTtcbiAgICAgIHRoaXMudG9rcy5saW5lU3RhcnQgPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgICB9XG4gIH1cbn07XG5cbmxwLmxvb2tBaGVhZCA9IGZ1bmN0aW9uIChuKSB7XG4gIHdoaWxlIChuID4gdGhpcy5haGVhZC5sZW5ndGgpIHRoaXMuYWhlYWQucHVzaCh0aGlzLnJlYWRUb2tlbigpKTtcbiAgcmV0dXJuIHRoaXMuYWhlYWRbbiAtIDFdO1xufTtcblxufSx7XCIuLlwiOjIsXCIuL3N0YXRlXCI6Nn1dfSx7fSxbNF0pKDQpXG59KTsiLCIoZnVuY3Rpb24oZil7aWYodHlwZW9mIGV4cG9ydHM9PT1cIm9iamVjdFwiJiZ0eXBlb2YgbW9kdWxlIT09XCJ1bmRlZmluZWRcIil7bW9kdWxlLmV4cG9ydHM9ZigpfWVsc2UgaWYodHlwZW9mIGRlZmluZT09PVwiZnVuY3Rpb25cIiYmZGVmaW5lLmFtZCl7ZGVmaW5lKFtdLGYpfWVsc2V7dmFyIGc7aWYodHlwZW9mIHdpbmRvdyE9PVwidW5kZWZpbmVkXCIpe2c9d2luZG93fWVsc2UgaWYodHlwZW9mIGdsb2JhbCE9PVwidW5kZWZpbmVkXCIpe2c9Z2xvYmFsfWVsc2UgaWYodHlwZW9mIHNlbGYhPT1cInVuZGVmaW5lZFwiKXtnPXNlbGZ9ZWxzZXtnPXRoaXN9KGcuYWNvcm4gfHwgKGcuYWNvcm4gPSB7fSkpLndhbGsgPSBmKCl9fSkoZnVuY3Rpb24oKXt2YXIgZGVmaW5lLG1vZHVsZSxleHBvcnRzO3JldHVybiAoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSh7MTpbZnVuY3Rpb24oX2RlcmVxXyxtb2R1bGUsZXhwb3J0cyl7XG4vLyBBU1Qgd2Fsa2VyIG1vZHVsZSBmb3IgTW96aWxsYSBQYXJzZXIgQVBJIGNvbXBhdGlibGUgdHJlZXNcblxuLy8gQSBzaW1wbGUgd2FsayBpcyBvbmUgd2hlcmUgeW91IHNpbXBseSBzcGVjaWZ5IGNhbGxiYWNrcyB0byBiZVxuLy8gY2FsbGVkIG9uIHNwZWNpZmljIG5vZGVzLiBUaGUgbGFzdCB0d28gYXJndW1lbnRzIGFyZSBvcHRpb25hbC4gQVxuLy8gc2ltcGxlIHVzZSB3b3VsZCBiZVxuLy9cbi8vICAgICB3YWxrLnNpbXBsZShteVRyZWUsIHtcbi8vICAgICAgICAgRXhwcmVzc2lvbjogZnVuY3Rpb24obm9kZSkgeyAuLi4gfVxuLy8gICAgIH0pO1xuLy9cbi8vIHRvIGRvIHNvbWV0aGluZyB3aXRoIGFsbCBleHByZXNzaW9ucy4gQWxsIFBhcnNlciBBUEkgbm9kZSB0eXBlc1xuLy8gY2FuIGJlIHVzZWQgdG8gaWRlbnRpZnkgbm9kZSB0eXBlcywgYXMgd2VsbCBhcyBFeHByZXNzaW9uLFxuLy8gU3RhdGVtZW50LCBhbmQgU2NvcGVCb2R5LCB3aGljaCBkZW5vdGUgY2F0ZWdvcmllcyBvZiBub2Rlcy5cbi8vXG4vLyBUaGUgYmFzZSBhcmd1bWVudCBjYW4gYmUgdXNlZCB0byBwYXNzIGEgY3VzdG9tIChyZWN1cnNpdmUpXG4vLyB3YWxrZXIsIGFuZCBzdGF0ZSBjYW4gYmUgdXNlZCB0byBnaXZlIHRoaXMgd2Fsa2VkIGFuIGluaXRpYWxcbi8vIHN0YXRlLlxuXG5cInVzZSBzdHJpY3RcIjtcblxuZXhwb3J0cy5fX2VzTW9kdWxlID0gdHJ1ZTtcbmV4cG9ydHMuc2ltcGxlID0gc2ltcGxlO1xuZXhwb3J0cy5hbmNlc3RvciA9IGFuY2VzdG9yO1xuZXhwb3J0cy5yZWN1cnNpdmUgPSByZWN1cnNpdmU7XG5leHBvcnRzLmZpbmROb2RlQXQgPSBmaW5kTm9kZUF0O1xuZXhwb3J0cy5maW5kTm9kZUFyb3VuZCA9IGZpbmROb2RlQXJvdW5kO1xuZXhwb3J0cy5maW5kTm9kZUFmdGVyID0gZmluZE5vZGVBZnRlcjtcbmV4cG9ydHMuZmluZE5vZGVCZWZvcmUgPSBmaW5kTm9kZUJlZm9yZTtcbmV4cG9ydHMubWFrZSA9IG1ha2U7XG5cbmZ1bmN0aW9uIF9jbGFzc0NhbGxDaGVjayhpbnN0YW5jZSwgQ29uc3RydWN0b3IpIHsgaWYgKCEoaW5zdGFuY2UgaW5zdGFuY2VvZiBDb25zdHJ1Y3RvcikpIHsgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkNhbm5vdCBjYWxsIGEgY2xhc3MgYXMgYSBmdW5jdGlvblwiKTsgfSB9XG5cbmZ1bmN0aW9uIHNpbXBsZShub2RlLCB2aXNpdG9ycywgYmFzZSwgc3RhdGUsIG92ZXJyaWRlKSB7XG4gIGlmICghYmFzZSkgYmFzZSA9IGV4cG9ydHMuYmFzZTsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICB2YXIgdHlwZSA9IG92ZXJyaWRlIHx8IG5vZGUudHlwZSxcbiAgICAgICAgZm91bmQgPSB2aXNpdG9yc1t0eXBlXTtcbiAgICBiYXNlW3R5cGVdKG5vZGUsIHN0LCBjKTtcbiAgICBpZiAoZm91bmQpIGZvdW5kKG5vZGUsIHN0KTtcbiAgfSkobm9kZSwgc3RhdGUsIG92ZXJyaWRlKTtcbn1cblxuLy8gQW4gYW5jZXN0b3Igd2FsayBidWlsZHMgdXAgYW4gYXJyYXkgb2YgYW5jZXN0b3Igbm9kZXMgKGluY2x1ZGluZ1xuLy8gdGhlIGN1cnJlbnQgbm9kZSkgYW5kIHBhc3NlcyB0aGVtIHRvIHRoZSBjYWxsYmFjayBhcyB0aGUgc3RhdGUgcGFyYW1ldGVyLlxuXG5mdW5jdGlvbiBhbmNlc3Rvcihub2RlLCB2aXNpdG9ycywgYmFzZSwgc3RhdGUpIHtcbiAgaWYgKCFiYXNlKSBiYXNlID0gZXhwb3J0cy5iYXNlO1xuICBpZiAoIXN0YXRlKSBzdGF0ZSA9IFtdOyhmdW5jdGlvbiBjKG5vZGUsIHN0LCBvdmVycmlkZSkge1xuICAgIHZhciB0eXBlID0gb3ZlcnJpZGUgfHwgbm9kZS50eXBlLFxuICAgICAgICBmb3VuZCA9IHZpc2l0b3JzW3R5cGVdO1xuICAgIGlmIChub2RlICE9IHN0W3N0Lmxlbmd0aCAtIDFdKSB7XG4gICAgICBzdCA9IHN0LnNsaWNlKCk7XG4gICAgICBzdC5wdXNoKG5vZGUpO1xuICAgIH1cbiAgICBiYXNlW3R5cGVdKG5vZGUsIHN0LCBjKTtcbiAgICBpZiAoZm91bmQpIGZvdW5kKG5vZGUsIHN0KTtcbiAgfSkobm9kZSwgc3RhdGUpO1xufVxuXG4vLyBBIHJlY3Vyc2l2ZSB3YWxrIGlzIG9uZSB3aGVyZSB5b3VyIGZ1bmN0aW9ucyBvdmVycmlkZSB0aGUgZGVmYXVsdFxuLy8gd2Fsa2Vycy4gVGhleSBjYW4gbW9kaWZ5IGFuZCByZXBsYWNlIHRoZSBzdGF0ZSBwYXJhbWV0ZXIgdGhhdCdzXG4vLyB0aHJlYWRlZCB0aHJvdWdoIHRoZSB3YWxrLCBhbmQgY2FuIG9wdCBob3cgYW5kIHdoZXRoZXIgdG8gd2Fsa1xuLy8gdGhlaXIgY2hpbGQgbm9kZXMgKGJ5IGNhbGxpbmcgdGhlaXIgdGhpcmQgYXJndW1lbnQgb24gdGhlc2Vcbi8vIG5vZGVzKS5cblxuZnVuY3Rpb24gcmVjdXJzaXZlKG5vZGUsIHN0YXRlLCBmdW5jcywgYmFzZSwgb3ZlcnJpZGUpIHtcbiAgdmFyIHZpc2l0b3IgPSBmdW5jcyA/IGV4cG9ydHMubWFrZShmdW5jcywgYmFzZSkgOiBiYXNlOyhmdW5jdGlvbiBjKG5vZGUsIHN0LCBvdmVycmlkZSkge1xuICAgIHZpc2l0b3Jbb3ZlcnJpZGUgfHwgbm9kZS50eXBlXShub2RlLCBzdCwgYyk7XG4gIH0pKG5vZGUsIHN0YXRlLCBvdmVycmlkZSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VUZXN0KHRlc3QpIHtcbiAgaWYgKHR5cGVvZiB0ZXN0ID09IFwic3RyaW5nXCIpIHJldHVybiBmdW5jdGlvbiAodHlwZSkge1xuICAgIHJldHVybiB0eXBlID09IHRlc3Q7XG4gIH07ZWxzZSBpZiAoIXRlc3QpIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH07ZWxzZSByZXR1cm4gdGVzdDtcbn1cblxudmFyIEZvdW5kID0gZnVuY3Rpb24gRm91bmQobm9kZSwgc3RhdGUpIHtcbiAgX2NsYXNzQ2FsbENoZWNrKHRoaXMsIEZvdW5kKTtcblxuICB0aGlzLm5vZGUgPSBub2RlO3RoaXMuc3RhdGUgPSBzdGF0ZTtcbn1cblxuLy8gRmluZCBhIG5vZGUgd2l0aCBhIGdpdmVuIHN0YXJ0LCBlbmQsIGFuZCB0eXBlIChhbGwgYXJlIG9wdGlvbmFsLFxuLy8gbnVsbCBjYW4gYmUgdXNlZCBhcyB3aWxkY2FyZCkuIFJldHVybnMgYSB7bm9kZSwgc3RhdGV9IG9iamVjdCwgb3Jcbi8vIHVuZGVmaW5lZCB3aGVuIGl0IGRvZXNuJ3QgZmluZCBhIG1hdGNoaW5nIG5vZGUuXG47XG5cbmZ1bmN0aW9uIGZpbmROb2RlQXQobm9kZSwgc3RhcnQsIGVuZCwgdGVzdCwgYmFzZSwgc3RhdGUpIHtcbiAgdGVzdCA9IG1ha2VUZXN0KHRlc3QpO1xuICBpZiAoIWJhc2UpIGJhc2UgPSBleHBvcnRzLmJhc2U7XG4gIHRyeSB7XG4gICAgOyhmdW5jdGlvbiBjKG5vZGUsIHN0LCBvdmVycmlkZSkge1xuICAgICAgdmFyIHR5cGUgPSBvdmVycmlkZSB8fCBub2RlLnR5cGU7XG4gICAgICBpZiAoKHN0YXJ0ID09IG51bGwgfHwgbm9kZS5zdGFydCA8PSBzdGFydCkgJiYgKGVuZCA9PSBudWxsIHx8IG5vZGUuZW5kID49IGVuZCkpIGJhc2VbdHlwZV0obm9kZSwgc3QsIGMpO1xuICAgICAgaWYgKHRlc3QodHlwZSwgbm9kZSkgJiYgKHN0YXJ0ID09IG51bGwgfHwgbm9kZS5zdGFydCA9PSBzdGFydCkgJiYgKGVuZCA9PSBudWxsIHx8IG5vZGUuZW5kID09IGVuZCkpIHRocm93IG5ldyBGb3VuZChub2RlLCBzdCk7XG4gICAgfSkobm9kZSwgc3RhdGUpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBGb3VuZCkgcmV0dXJuIGU7XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vLyBGaW5kIHRoZSBpbm5lcm1vc3Qgbm9kZSBvZiBhIGdpdmVuIHR5cGUgdGhhdCBjb250YWlucyB0aGUgZ2l2ZW5cbi8vIHBvc2l0aW9uLiBJbnRlcmZhY2Ugc2ltaWxhciB0byBmaW5kTm9kZUF0LlxuXG5mdW5jdGlvbiBmaW5kTm9kZUFyb3VuZChub2RlLCBwb3MsIHRlc3QsIGJhc2UsIHN0YXRlKSB7XG4gIHRlc3QgPSBtYWtlVGVzdCh0ZXN0KTtcbiAgaWYgKCFiYXNlKSBiYXNlID0gZXhwb3J0cy5iYXNlO1xuICB0cnkge1xuICAgIDsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICAgIHZhciB0eXBlID0gb3ZlcnJpZGUgfHwgbm9kZS50eXBlO1xuICAgICAgaWYgKG5vZGUuc3RhcnQgPiBwb3MgfHwgbm9kZS5lbmQgPCBwb3MpIHJldHVybjtcbiAgICAgIGJhc2VbdHlwZV0obm9kZSwgc3QsIGMpO1xuICAgICAgaWYgKHRlc3QodHlwZSwgbm9kZSkpIHRocm93IG5ldyBGb3VuZChub2RlLCBzdCk7XG4gICAgfSkobm9kZSwgc3RhdGUpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBGb3VuZCkgcmV0dXJuIGU7XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vLyBGaW5kIHRoZSBvdXRlcm1vc3QgbWF0Y2hpbmcgbm9kZSBhZnRlciBhIGdpdmVuIHBvc2l0aW9uLlxuXG5mdW5jdGlvbiBmaW5kTm9kZUFmdGVyKG5vZGUsIHBvcywgdGVzdCwgYmFzZSwgc3RhdGUpIHtcbiAgdGVzdCA9IG1ha2VUZXN0KHRlc3QpO1xuICBpZiAoIWJhc2UpIGJhc2UgPSBleHBvcnRzLmJhc2U7XG4gIHRyeSB7XG4gICAgOyhmdW5jdGlvbiBjKG5vZGUsIHN0LCBvdmVycmlkZSkge1xuICAgICAgaWYgKG5vZGUuZW5kIDwgcG9zKSByZXR1cm47XG4gICAgICB2YXIgdHlwZSA9IG92ZXJyaWRlIHx8IG5vZGUudHlwZTtcbiAgICAgIGlmIChub2RlLnN0YXJ0ID49IHBvcyAmJiB0ZXN0KHR5cGUsIG5vZGUpKSB0aHJvdyBuZXcgRm91bmQobm9kZSwgc3QpO1xuICAgICAgYmFzZVt0eXBlXShub2RlLCBzdCwgYyk7XG4gICAgfSkobm9kZSwgc3RhdGUpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBGb3VuZCkgcmV0dXJuIGU7XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vLyBGaW5kIHRoZSBvdXRlcm1vc3QgbWF0Y2hpbmcgbm9kZSBiZWZvcmUgYSBnaXZlbiBwb3NpdGlvbi5cblxuZnVuY3Rpb24gZmluZE5vZGVCZWZvcmUobm9kZSwgcG9zLCB0ZXN0LCBiYXNlLCBzdGF0ZSkge1xuICB0ZXN0ID0gbWFrZVRlc3QodGVzdCk7XG4gIGlmICghYmFzZSkgYmFzZSA9IGV4cG9ydHMuYmFzZTtcbiAgdmFyIG1heCA9IHVuZGVmaW5lZDsoZnVuY3Rpb24gYyhub2RlLCBzdCwgb3ZlcnJpZGUpIHtcbiAgICBpZiAobm9kZS5zdGFydCA+IHBvcykgcmV0dXJuO1xuICAgIHZhciB0eXBlID0gb3ZlcnJpZGUgfHwgbm9kZS50eXBlO1xuICAgIGlmIChub2RlLmVuZCA8PSBwb3MgJiYgKCFtYXggfHwgbWF4Lm5vZGUuZW5kIDwgbm9kZS5lbmQpICYmIHRlc3QodHlwZSwgbm9kZSkpIG1heCA9IG5ldyBGb3VuZChub2RlLCBzdCk7XG4gICAgYmFzZVt0eXBlXShub2RlLCBzdCwgYyk7XG4gIH0pKG5vZGUsIHN0YXRlKTtcbiAgcmV0dXJuIG1heDtcbn1cblxuLy8gVXNlZCB0byBjcmVhdGUgYSBjdXN0b20gd2Fsa2VyLiBXaWxsIGZpbGwgaW4gYWxsIG1pc3Npbmcgbm9kZVxuLy8gdHlwZSBwcm9wZXJ0aWVzIHdpdGggdGhlIGRlZmF1bHRzLlxuXG5mdW5jdGlvbiBtYWtlKGZ1bmNzLCBiYXNlKSB7XG4gIGlmICghYmFzZSkgYmFzZSA9IGV4cG9ydHMuYmFzZTtcbiAgdmFyIHZpc2l0b3IgPSB7fTtcbiAgZm9yICh2YXIgdHlwZSBpbiBiYXNlKSB2aXNpdG9yW3R5cGVdID0gYmFzZVt0eXBlXTtcbiAgZm9yICh2YXIgdHlwZSBpbiBmdW5jcykgdmlzaXRvclt0eXBlXSA9IGZ1bmNzW3R5cGVdO1xuICByZXR1cm4gdmlzaXRvcjtcbn1cblxuZnVuY3Rpb24gc2tpcFRocm91Z2gobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLCBzdCk7XG59XG5mdW5jdGlvbiBpZ25vcmUoX25vZGUsIF9zdCwgX2MpIHt9XG5cbi8vIE5vZGUgd2Fsa2Vycy5cblxudmFyIGJhc2UgPSB7fTtcblxuZXhwb3J0cy5iYXNlID0gYmFzZTtcbmJhc2UuUHJvZ3JhbSA9IGJhc2UuQmxvY2tTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmJvZHkubGVuZ3RoOyArK2kpIHtcbiAgICBjKG5vZGUuYm9keVtpXSwgc3QsIFwiU3RhdGVtZW50XCIpO1xuICB9XG59O1xuYmFzZS5TdGF0ZW1lbnQgPSBza2lwVGhyb3VnaDtcbmJhc2UuRW1wdHlTdGF0ZW1lbnQgPSBpZ25vcmU7XG5iYXNlLkV4cHJlc3Npb25TdGF0ZW1lbnQgPSBiYXNlLlBhcmVudGhlc2l6ZWRFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIHJldHVybiBjKG5vZGUuZXhwcmVzc2lvbiwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5iYXNlLklmU3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS50ZXN0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUuY29uc2VxdWVudCwgc3QsIFwiU3RhdGVtZW50XCIpO1xuICBpZiAobm9kZS5hbHRlcm5hdGUpIGMobm9kZS5hbHRlcm5hdGUsIHN0LCBcIlN0YXRlbWVudFwiKTtcbn07XG5iYXNlLkxhYmVsZWRTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgcmV0dXJuIGMobm9kZS5ib2R5LCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5CcmVha1N0YXRlbWVudCA9IGJhc2UuQ29udGludWVTdGF0ZW1lbnQgPSBpZ25vcmU7XG5iYXNlLldpdGhTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLm9iamVjdCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgYyhub2RlLmJvZHksIHN0LCBcIlN0YXRlbWVudFwiKTtcbn07XG5iYXNlLlN3aXRjaFN0YXRlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUuZGlzY3JpbWluYW50LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuY2FzZXMubGVuZ3RoOyArK2kpIHtcbiAgICB2YXIgY3MgPSBub2RlLmNhc2VzW2ldO1xuICAgIGlmIChjcy50ZXN0KSBjKGNzLnRlc3QsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBjcy5jb25zZXF1ZW50Lmxlbmd0aDsgKytqKSB7XG4gICAgICBjKGNzLmNvbnNlcXVlbnRbal0sIHN0LCBcIlN0YXRlbWVudFwiKTtcbiAgICB9XG4gIH1cbn07XG5iYXNlLlJldHVyblN0YXRlbWVudCA9IGJhc2UuWWllbGRFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGlmIChub2RlLmFyZ3VtZW50KSBjKG5vZGUuYXJndW1lbnQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuYmFzZS5UaHJvd1N0YXRlbWVudCA9IGJhc2UuU3ByZWFkRWxlbWVudCA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICByZXR1cm4gYyhub2RlLmFyZ3VtZW50LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuVHJ5U3RhdGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS5ibG9jaywgc3QsIFwiU3RhdGVtZW50XCIpO1xuICBpZiAobm9kZS5oYW5kbGVyKSB7XG4gICAgYyhub2RlLmhhbmRsZXIucGFyYW0sIHN0LCBcIlBhdHRlcm5cIik7XG4gICAgYyhub2RlLmhhbmRsZXIuYm9keSwgc3QsIFwiU2NvcGVCb2R5XCIpO1xuICB9XG4gIGlmIChub2RlLmZpbmFsaXplcikgYyhub2RlLmZpbmFsaXplciwgc3QsIFwiU3RhdGVtZW50XCIpO1xufTtcbmJhc2UuV2hpbGVTdGF0ZW1lbnQgPSBiYXNlLkRvV2hpbGVTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLnRlc3QsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5ib2R5LCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5Gb3JTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgaWYgKG5vZGUuaW5pdCkgYyhub2RlLmluaXQsIHN0LCBcIkZvckluaXRcIik7XG4gIGlmIChub2RlLnRlc3QpIGMobm9kZS50ZXN0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBpZiAobm9kZS51cGRhdGUpIGMobm9kZS51cGRhdGUsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5ib2R5LCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5Gb3JJblN0YXRlbWVudCA9IGJhc2UuRm9yT2ZTdGF0ZW1lbnQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLmxlZnQsIHN0LCBcIkZvckluaXRcIik7XG4gIGMobm9kZS5yaWdodCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgYyhub2RlLmJvZHksIHN0LCBcIlN0YXRlbWVudFwiKTtcbn07XG5iYXNlLkZvckluaXQgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgaWYgKG5vZGUudHlwZSA9PSBcIlZhcmlhYmxlRGVjbGFyYXRpb25cIikgYyhub2RlLCBzdCk7ZWxzZSBjKG5vZGUsIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuYmFzZS5EZWJ1Z2dlclN0YXRlbWVudCA9IGlnbm9yZTtcblxuYmFzZS5GdW5jdGlvbkRlY2xhcmF0aW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIHJldHVybiBjKG5vZGUsIHN0LCBcIkZ1bmN0aW9uXCIpO1xufTtcbmJhc2UuVmFyaWFibGVEZWNsYXJhdGlvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuZGVjbGFyYXRpb25zLmxlbmd0aDsgKytpKSB7XG4gICAgdmFyIGRlY2wgPSBub2RlLmRlY2xhcmF0aW9uc1tpXTtcbiAgICBjKGRlY2wuaWQsIHN0LCBcIlBhdHRlcm5cIik7XG4gICAgaWYgKGRlY2wuaW5pdCkgYyhkZWNsLmluaXQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIH1cbn07XG5cbmJhc2UuRnVuY3Rpb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLnBhcmFtcy5sZW5ndGg7IGkrKykge1xuICAgIGMobm9kZS5wYXJhbXNbaV0sIHN0LCBcIlBhdHRlcm5cIik7XG4gIH1jKG5vZGUuYm9keSwgc3QsIG5vZGUuZXhwcmVzc2lvbiA/IFwiU2NvcGVFeHByZXNzaW9uXCIgOiBcIlNjb3BlQm9keVwiKTtcbn07XG4vLyBGSVhNRSBkcm9wIHRoZXNlIG5vZGUgdHlwZXMgaW4gbmV4dCBtYWpvciB2ZXJzaW9uXG4vLyAoVGhleSBhcmUgYXdrd2FyZCwgYW5kIGluIEVTNiBldmVyeSBibG9jayBjYW4gYmUgYSBzY29wZS4pXG5iYXNlLlNjb3BlQm9keSA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICByZXR1cm4gYyhub2RlLCBzdCwgXCJTdGF0ZW1lbnRcIik7XG59O1xuYmFzZS5TY29wZUV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgcmV0dXJuIGMobm9kZSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbn07XG5cbmJhc2UuUGF0dGVybiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBpZiAobm9kZS50eXBlID09IFwiSWRlbnRpZmllclwiKSBjKG5vZGUsIHN0LCBcIlZhcmlhYmxlUGF0dGVyblwiKTtlbHNlIGlmIChub2RlLnR5cGUgPT0gXCJNZW1iZXJFeHByZXNzaW9uXCIpIGMobm9kZSwgc3QsIFwiTWVtYmVyUGF0dGVyblwiKTtlbHNlIGMobm9kZSwgc3QpO1xufTtcbmJhc2UuVmFyaWFibGVQYXR0ZXJuID0gaWdub3JlO1xuYmFzZS5NZW1iZXJQYXR0ZXJuID0gc2tpcFRocm91Z2g7XG5iYXNlLlJlc3RFbGVtZW50ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIHJldHVybiBjKG5vZGUuYXJndW1lbnQsIHN0LCBcIlBhdHRlcm5cIik7XG59O1xuYmFzZS5BcnJheVBhdHRlcm4gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmVsZW1lbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgdmFyIGVsdCA9IG5vZGUuZWxlbWVudHNbaV07XG4gICAgaWYgKGVsdCkgYyhlbHQsIHN0LCBcIlBhdHRlcm5cIik7XG4gIH1cbn07XG5iYXNlLk9iamVjdFBhdHRlcm4gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLnByb3BlcnRpZXMubGVuZ3RoOyArK2kpIHtcbiAgICBjKG5vZGUucHJvcGVydGllc1tpXS52YWx1ZSwgc3QsIFwiUGF0dGVyblwiKTtcbiAgfVxufTtcblxuYmFzZS5FeHByZXNzaW9uID0gc2tpcFRocm91Z2g7XG5iYXNlLlRoaXNFeHByZXNzaW9uID0gYmFzZS5TdXBlciA9IGJhc2UuTWV0YVByb3BlcnR5ID0gaWdub3JlO1xuYmFzZS5BcnJheUV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLmVsZW1lbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgdmFyIGVsdCA9IG5vZGUuZWxlbWVudHNbaV07XG4gICAgaWYgKGVsdCkgYyhlbHQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIH1cbn07XG5iYXNlLk9iamVjdEV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2RlLnByb3BlcnRpZXMubGVuZ3RoOyArK2kpIHtcbiAgICBjKG5vZGUucHJvcGVydGllc1tpXSwgc3QpO1xuICB9XG59O1xuYmFzZS5GdW5jdGlvbkV4cHJlc3Npb24gPSBiYXNlLkFycm93RnVuY3Rpb25FeHByZXNzaW9uID0gYmFzZS5GdW5jdGlvbkRlY2xhcmF0aW9uO1xuYmFzZS5TZXF1ZW5jZUV4cHJlc3Npb24gPSBiYXNlLlRlbXBsYXRlTGl0ZXJhbCA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuZXhwcmVzc2lvbnMubGVuZ3RoOyArK2kpIHtcbiAgICBjKG5vZGUuZXhwcmVzc2lvbnNbaV0sIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIH1cbn07XG5iYXNlLlVuYXJ5RXhwcmVzc2lvbiA9IGJhc2UuVXBkYXRlRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUuYXJndW1lbnQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuYmFzZS5CaW5hcnlFeHByZXNzaW9uID0gYmFzZS5Mb2dpY2FsRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUubGVmdCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgYyhub2RlLnJpZ2h0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuQXNzaWdubWVudEV4cHJlc3Npb24gPSBiYXNlLkFzc2lnbm1lbnRQYXR0ZXJuID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS5sZWZ0LCBzdCwgXCJQYXR0ZXJuXCIpO1xuICBjKG5vZGUucmlnaHQsIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuYmFzZS5Db25kaXRpb25hbEV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLnRlc3QsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5jb25zZXF1ZW50LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUuYWx0ZXJuYXRlLCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuTmV3RXhwcmVzc2lvbiA9IGJhc2UuQ2FsbEV4cHJlc3Npb24gPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgYyhub2RlLmNhbGxlZSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgaWYgKG5vZGUuYXJndW1lbnRzKSBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuYXJndW1lbnRzLmxlbmd0aDsgKytpKSB7XG4gICAgYyhub2RlLmFyZ3VtZW50c1tpXSwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgfVxufTtcbmJhc2UuTWVtYmVyRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBjKG5vZGUub2JqZWN0LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBpZiAobm9kZS5jb21wdXRlZCkgYyhub2RlLnByb3BlcnR5LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcbmJhc2UuRXhwb3J0TmFtZWREZWNsYXJhdGlvbiA9IGJhc2UuRXhwb3J0RGVmYXVsdERlY2xhcmF0aW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGlmIChub2RlLmRlY2xhcmF0aW9uKSBjKG5vZGUuZGVjbGFyYXRpb24sIHN0KTtcbn07XG5iYXNlLkltcG9ydERlY2xhcmF0aW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5zcGVjaWZpZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgYyhub2RlLnNwZWNpZmllcnNbaV0sIHN0KTtcbiAgfVxufTtcbmJhc2UuSW1wb3J0U3BlY2lmaWVyID0gYmFzZS5JbXBvcnREZWZhdWx0U3BlY2lmaWVyID0gYmFzZS5JbXBvcnROYW1lc3BhY2VTcGVjaWZpZXIgPSBiYXNlLklkZW50aWZpZXIgPSBiYXNlLkxpdGVyYWwgPSBpZ25vcmU7XG5cbmJhc2UuVGFnZ2VkVGVtcGxhdGVFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGMobm9kZS50YWcsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGMobm9kZS5xdWFzaSwgc3QpO1xufTtcbmJhc2UuQ2xhc3NEZWNsYXJhdGlvbiA9IGJhc2UuQ2xhc3NFeHByZXNzaW9uID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIHJldHVybiBjKG5vZGUsIHN0LCBcIkNsYXNzXCIpO1xufTtcbmJhc2UuQ2xhc3MgPSBmdW5jdGlvbiAobm9kZSwgc3QsIGMpIHtcbiAgaWYgKG5vZGUuaWQpIGMobm9kZS5pZCwgc3QsIFwiUGF0dGVyblwiKTtcbiAgaWYgKG5vZGUuc3VwZXJDbGFzcykgYyhub2RlLnN1cGVyQ2xhc3MsIHN0LCBcIkV4cHJlc3Npb25cIik7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgbm9kZS5ib2R5LmJvZHkubGVuZ3RoOyBpKyspIHtcbiAgICBjKG5vZGUuYm9keS5ib2R5W2ldLCBzdCk7XG4gIH1cbn07XG5iYXNlLk1ldGhvZERlZmluaXRpb24gPSBiYXNlLlByb3BlcnR5ID0gZnVuY3Rpb24gKG5vZGUsIHN0LCBjKSB7XG4gIGlmIChub2RlLmNvbXB1dGVkKSBjKG5vZGUua2V5LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xuICBjKG5vZGUudmFsdWUsIHN0LCBcIkV4cHJlc3Npb25cIik7XG59O1xuYmFzZS5Db21wcmVoZW5zaW9uRXhwcmVzc2lvbiA9IGZ1bmN0aW9uIChub2RlLCBzdCwgYykge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IG5vZGUuYmxvY2tzLmxlbmd0aDsgaSsrKSB7XG4gICAgYyhub2RlLmJsb2Nrc1tpXS5yaWdodCwgc3QsIFwiRXhwcmVzc2lvblwiKTtcbiAgfWMobm9kZS5ib2R5LCBzdCwgXCJFeHByZXNzaW9uXCIpO1xufTtcblxufSx7fV19LHt9LFsxXSkoMSlcbn0pOyIsImlmICh0eXBlb2YgT2JqZWN0LmNyZWF0ZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAvLyBpbXBsZW1lbnRhdGlvbiBmcm9tIHN0YW5kYXJkIG5vZGUuanMgJ3V0aWwnIG1vZHVsZVxuICBtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGluaGVyaXRzKGN0b3IsIHN1cGVyQ3Rvcikge1xuICAgIGN0b3Iuc3VwZXJfID0gc3VwZXJDdG9yXG4gICAgY3Rvci5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHN1cGVyQ3Rvci5wcm90b3R5cGUsIHtcbiAgICAgIGNvbnN0cnVjdG9yOiB7XG4gICAgICAgIHZhbHVlOiBjdG9yLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZVxuICAgICAgfVxuICAgIH0pO1xuICB9O1xufSBlbHNlIHtcbiAgLy8gb2xkIHNjaG9vbCBzaGltIGZvciBvbGQgYnJvd3NlcnNcbiAgbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBpbmhlcml0cyhjdG9yLCBzdXBlckN0b3IpIHtcbiAgICBjdG9yLnN1cGVyXyA9IHN1cGVyQ3RvclxuICAgIHZhciBUZW1wQ3RvciA9IGZ1bmN0aW9uICgpIHt9XG4gICAgVGVtcEN0b3IucHJvdG90eXBlID0gc3VwZXJDdG9yLnByb3RvdHlwZVxuICAgIGN0b3IucHJvdG90eXBlID0gbmV3IFRlbXBDdG9yKClcbiAgICBjdG9yLnByb3RvdHlwZS5jb25zdHJ1Y3RvciA9IGN0b3JcbiAgfVxufVxuIiwiLy8gc2hpbSBmb3IgdXNpbmcgcHJvY2VzcyBpbiBicm93c2VyXG5cbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcbnZhciBxdWV1ZSA9IFtdO1xudmFyIGRyYWluaW5nID0gZmFsc2U7XG52YXIgY3VycmVudFF1ZXVlO1xudmFyIHF1ZXVlSW5kZXggPSAtMTtcblxuZnVuY3Rpb24gY2xlYW5VcE5leHRUaWNrKCkge1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgaWYgKGN1cnJlbnRRdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgcXVldWUgPSBjdXJyZW50UXVldWUuY29uY2F0KHF1ZXVlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZUluZGV4ID0gLTE7XG4gICAgfVxuICAgIGlmIChxdWV1ZS5sZW5ndGgpIHtcbiAgICAgICAgZHJhaW5RdWV1ZSgpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgdGltZW91dCA9IHNldFRpbWVvdXQoY2xlYW5VcE5leHRUaWNrKTtcbiAgICBkcmFpbmluZyA9IHRydWU7XG5cbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgd2hpbGUgKCsrcXVldWVJbmRleCA8IGxlbikge1xuICAgICAgICAgICAgY3VycmVudFF1ZXVlW3F1ZXVlSW5kZXhdLnJ1bigpO1xuICAgICAgICB9XG4gICAgICAgIHF1ZXVlSW5kZXggPSAtMTtcbiAgICAgICAgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIH1cbiAgICBjdXJyZW50UXVldWUgPSBudWxsO1xuICAgIGRyYWluaW5nID0gZmFsc2U7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xufVxuXG5wcm9jZXNzLm5leHRUaWNrID0gZnVuY3Rpb24gKGZ1bikge1xuICAgIHZhciBhcmdzID0gbmV3IEFycmF5KGFyZ3VtZW50cy5sZW5ndGggLSAxKTtcbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgZm9yICh2YXIgaSA9IDE7IGkgPCBhcmd1bWVudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGFyZ3NbaSAtIDFdID0gYXJndW1lbnRzW2ldO1xuICAgICAgICB9XG4gICAgfVxuICAgIHF1ZXVlLnB1c2gobmV3IEl0ZW0oZnVuLCBhcmdzKSk7XG4gICAgaWYgKHF1ZXVlLmxlbmd0aCA9PT0gMSAmJiAhZHJhaW5pbmcpIHtcbiAgICAgICAgc2V0VGltZW91dChkcmFpblF1ZXVlLCAwKTtcbiAgICB9XG59O1xuXG4vLyB2OCBsaWtlcyBwcmVkaWN0aWJsZSBvYmplY3RzXG5mdW5jdGlvbiBJdGVtKGZ1biwgYXJyYXkpIHtcbiAgICB0aGlzLmZ1biA9IGZ1bjtcbiAgICB0aGlzLmFycmF5ID0gYXJyYXk7XG59XG5JdGVtLnByb3RvdHlwZS5ydW4gPSBmdW5jdGlvbiAoKSB7XG4gICAgdGhpcy5mdW4uYXBwbHkobnVsbCwgdGhpcy5hcnJheSk7XG59O1xucHJvY2Vzcy50aXRsZSA9ICdicm93c2VyJztcbnByb2Nlc3MuYnJvd3NlciA9IHRydWU7XG5wcm9jZXNzLmVudiA9IHt9O1xucHJvY2Vzcy5hcmd2ID0gW107XG5wcm9jZXNzLnZlcnNpb24gPSAnJzsgLy8gZW1wdHkgc3RyaW5nIHRvIGF2b2lkIHJlZ2V4cCBpc3N1ZXNcbnByb2Nlc3MudmVyc2lvbnMgPSB7fTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnByb2Nlc3Mub24gPSBub29wO1xucHJvY2Vzcy5hZGRMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLm9uY2UgPSBub29wO1xucHJvY2Vzcy5vZmYgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVMaXN0ZW5lciA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUFsbExpc3RlbmVycyA9IG5vb3A7XG5wcm9jZXNzLmVtaXQgPSBub29wO1xuXG5wcm9jZXNzLmJpbmRpbmcgPSBmdW5jdGlvbiAobmFtZSkge1xuICAgIHRocm93IG5ldyBFcnJvcigncHJvY2Vzcy5iaW5kaW5nIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5cbi8vIFRPRE8oc2h0eWxtYW4pXG5wcm9jZXNzLmN3ZCA9IGZ1bmN0aW9uICgpIHsgcmV0dXJuICcvJyB9O1xucHJvY2Vzcy5jaGRpciA9IGZ1bmN0aW9uIChkaXIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuY2hkaXIgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcbnByb2Nlc3MudW1hc2sgPSBmdW5jdGlvbigpIHsgcmV0dXJuIDA7IH07XG4iLCJtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIGlzQnVmZmVyKGFyZykge1xuICByZXR1cm4gYXJnICYmIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnXG4gICAgJiYgdHlwZW9mIGFyZy5jb3B5ID09PSAnZnVuY3Rpb24nXG4gICAgJiYgdHlwZW9mIGFyZy5maWxsID09PSAnZnVuY3Rpb24nXG4gICAgJiYgdHlwZW9mIGFyZy5yZWFkVUludDggPT09ICdmdW5jdGlvbic7XG59IiwiLy8gQ29weXJpZ2h0IEpveWVudCwgSW5jLiBhbmQgb3RoZXIgTm9kZSBjb250cmlidXRvcnMuXG4vL1xuLy8gUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGFcbi8vIGNvcHkgb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGVcbi8vIFwiU29mdHdhcmVcIiksIHRvIGRlYWwgaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZ1xuLy8gd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHMgdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLFxuLy8gZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGwgY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdFxuLy8gcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpcyBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlXG4vLyBmb2xsb3dpbmcgY29uZGl0aW9uczpcbi8vXG4vLyBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZFxuLy8gaW4gYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4vL1xuLy8gVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTU1xuLy8gT1IgSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRlxuLy8gTUVSQ0hBTlRBQklMSVRZLCBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiBJTlxuLy8gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sXG4vLyBEQU1BR0VTIE9SIE9USEVSIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1Jcbi8vIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLCBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEVcbi8vIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTiBUSEUgU09GVFdBUkUuXG5cbnZhciBmb3JtYXRSZWdFeHAgPSAvJVtzZGolXS9nO1xuZXhwb3J0cy5mb3JtYXQgPSBmdW5jdGlvbihmKSB7XG4gIGlmICghaXNTdHJpbmcoZikpIHtcbiAgICB2YXIgb2JqZWN0cyA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYXJndW1lbnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBvYmplY3RzLnB1c2goaW5zcGVjdChhcmd1bWVudHNbaV0pKTtcbiAgICB9XG4gICAgcmV0dXJuIG9iamVjdHMuam9pbignICcpO1xuICB9XG5cbiAgdmFyIGkgPSAxO1xuICB2YXIgYXJncyA9IGFyZ3VtZW50cztcbiAgdmFyIGxlbiA9IGFyZ3MubGVuZ3RoO1xuICB2YXIgc3RyID0gU3RyaW5nKGYpLnJlcGxhY2UoZm9ybWF0UmVnRXhwLCBmdW5jdGlvbih4KSB7XG4gICAgaWYgKHggPT09ICclJScpIHJldHVybiAnJSc7XG4gICAgaWYgKGkgPj0gbGVuKSByZXR1cm4geDtcbiAgICBzd2l0Y2ggKHgpIHtcbiAgICAgIGNhc2UgJyVzJzogcmV0dXJuIFN0cmluZyhhcmdzW2krK10pO1xuICAgICAgY2FzZSAnJWQnOiByZXR1cm4gTnVtYmVyKGFyZ3NbaSsrXSk7XG4gICAgICBjYXNlICclaic6XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGFyZ3NbaSsrXSk7XG4gICAgICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgICAgICByZXR1cm4gJ1tDaXJjdWxhcl0nO1xuICAgICAgICB9XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4geDtcbiAgICB9XG4gIH0pO1xuICBmb3IgKHZhciB4ID0gYXJnc1tpXTsgaSA8IGxlbjsgeCA9IGFyZ3NbKytpXSkge1xuICAgIGlmIChpc051bGwoeCkgfHwgIWlzT2JqZWN0KHgpKSB7XG4gICAgICBzdHIgKz0gJyAnICsgeDtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyICs9ICcgJyArIGluc3BlY3QoeCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBzdHI7XG59O1xuXG5cbi8vIE1hcmsgdGhhdCBhIG1ldGhvZCBzaG91bGQgbm90IGJlIHVzZWQuXG4vLyBSZXR1cm5zIGEgbW9kaWZpZWQgZnVuY3Rpb24gd2hpY2ggd2FybnMgb25jZSBieSBkZWZhdWx0LlxuLy8gSWYgLS1uby1kZXByZWNhdGlvbiBpcyBzZXQsIHRoZW4gaXQgaXMgYSBuby1vcC5cbmV4cG9ydHMuZGVwcmVjYXRlID0gZnVuY3Rpb24oZm4sIG1zZykge1xuICAvLyBBbGxvdyBmb3IgZGVwcmVjYXRpbmcgdGhpbmdzIGluIHRoZSBwcm9jZXNzIG9mIHN0YXJ0aW5nIHVwLlxuICBpZiAoaXNVbmRlZmluZWQoZ2xvYmFsLnByb2Nlc3MpKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIGV4cG9ydHMuZGVwcmVjYXRlKGZuLCBtc2cpLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgfTtcbiAgfVxuXG4gIGlmIChwcm9jZXNzLm5vRGVwcmVjYXRpb24gPT09IHRydWUpIHtcbiAgICByZXR1cm4gZm47XG4gIH1cblxuICB2YXIgd2FybmVkID0gZmFsc2U7XG4gIGZ1bmN0aW9uIGRlcHJlY2F0ZWQoKSB7XG4gICAgaWYgKCF3YXJuZWQpIHtcbiAgICAgIGlmIChwcm9jZXNzLnRocm93RGVwcmVjYXRpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9IGVsc2UgaWYgKHByb2Nlc3MudHJhY2VEZXByZWNhdGlvbikge1xuICAgICAgICBjb25zb2xlLnRyYWNlKG1zZyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gICAgICB9XG4gICAgICB3YXJuZWQgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZm4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfVxuXG4gIHJldHVybiBkZXByZWNhdGVkO1xufTtcblxuXG52YXIgZGVidWdzID0ge307XG52YXIgZGVidWdFbnZpcm9uO1xuZXhwb3J0cy5kZWJ1Z2xvZyA9IGZ1bmN0aW9uKHNldCkge1xuICBpZiAoaXNVbmRlZmluZWQoZGVidWdFbnZpcm9uKSlcbiAgICBkZWJ1Z0Vudmlyb24gPSBwcm9jZXNzLmVudi5OT0RFX0RFQlVHIHx8ICcnO1xuICBzZXQgPSBzZXQudG9VcHBlckNhc2UoKTtcbiAgaWYgKCFkZWJ1Z3Nbc2V0XSkge1xuICAgIGlmIChuZXcgUmVnRXhwKCdcXFxcYicgKyBzZXQgKyAnXFxcXGInLCAnaScpLnRlc3QoZGVidWdFbnZpcm9uKSkge1xuICAgICAgdmFyIHBpZCA9IHByb2Nlc3MucGlkO1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHtcbiAgICAgICAgdmFyIG1zZyA9IGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cyk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoJyVzICVkOiAlcycsIHNldCwgcGlkLCBtc2cpO1xuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgZGVidWdzW3NldF0gPSBmdW5jdGlvbigpIHt9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gZGVidWdzW3NldF07XG59O1xuXG5cbi8qKlxuICogRWNob3MgdGhlIHZhbHVlIG9mIGEgdmFsdWUuIFRyeXMgdG8gcHJpbnQgdGhlIHZhbHVlIG91dFxuICogaW4gdGhlIGJlc3Qgd2F5IHBvc3NpYmxlIGdpdmVuIHRoZSBkaWZmZXJlbnQgdHlwZXMuXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IG9iaiBUaGUgb2JqZWN0IHRvIHByaW50IG91dC5cbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRzIE9wdGlvbmFsIG9wdGlvbnMgb2JqZWN0IHRoYXQgYWx0ZXJzIHRoZSBvdXRwdXQuXG4gKi9cbi8qIGxlZ2FjeTogb2JqLCBzaG93SGlkZGVuLCBkZXB0aCwgY29sb3JzKi9cbmZ1bmN0aW9uIGluc3BlY3Qob2JqLCBvcHRzKSB7XG4gIC8vIGRlZmF1bHQgb3B0aW9uc1xuICB2YXIgY3R4ID0ge1xuICAgIHNlZW46IFtdLFxuICAgIHN0eWxpemU6IHN0eWxpemVOb0NvbG9yXG4gIH07XG4gIC8vIGxlZ2FjeS4uLlxuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA+PSAzKSBjdHguZGVwdGggPSBhcmd1bWVudHNbMl07XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID49IDQpIGN0eC5jb2xvcnMgPSBhcmd1bWVudHNbM107XG4gIGlmIChpc0Jvb2xlYW4ob3B0cykpIHtcbiAgICAvLyBsZWdhY3kuLi5cbiAgICBjdHguc2hvd0hpZGRlbiA9IG9wdHM7XG4gIH0gZWxzZSBpZiAob3B0cykge1xuICAgIC8vIGdvdCBhbiBcIm9wdGlvbnNcIiBvYmplY3RcbiAgICBleHBvcnRzLl9leHRlbmQoY3R4LCBvcHRzKTtcbiAgfVxuICAvLyBzZXQgZGVmYXVsdCBvcHRpb25zXG4gIGlmIChpc1VuZGVmaW5lZChjdHguc2hvd0hpZGRlbikpIGN0eC5zaG93SGlkZGVuID0gZmFsc2U7XG4gIGlmIChpc1VuZGVmaW5lZChjdHguZGVwdGgpKSBjdHguZGVwdGggPSAyO1xuICBpZiAoaXNVbmRlZmluZWQoY3R4LmNvbG9ycykpIGN0eC5jb2xvcnMgPSBmYWxzZTtcbiAgaWYgKGlzVW5kZWZpbmVkKGN0eC5jdXN0b21JbnNwZWN0KSkgY3R4LmN1c3RvbUluc3BlY3QgPSB0cnVlO1xuICBpZiAoY3R4LmNvbG9ycykgY3R4LnN0eWxpemUgPSBzdHlsaXplV2l0aENvbG9yO1xuICByZXR1cm4gZm9ybWF0VmFsdWUoY3R4LCBvYmosIGN0eC5kZXB0aCk7XG59XG5leHBvcnRzLmluc3BlY3QgPSBpbnNwZWN0O1xuXG5cbi8vIGh0dHA6Ly9lbi53aWtpcGVkaWEub3JnL3dpa2kvQU5TSV9lc2NhcGVfY29kZSNncmFwaGljc1xuaW5zcGVjdC5jb2xvcnMgPSB7XG4gICdib2xkJyA6IFsxLCAyMl0sXG4gICdpdGFsaWMnIDogWzMsIDIzXSxcbiAgJ3VuZGVybGluZScgOiBbNCwgMjRdLFxuICAnaW52ZXJzZScgOiBbNywgMjddLFxuICAnd2hpdGUnIDogWzM3LCAzOV0sXG4gICdncmV5JyA6IFs5MCwgMzldLFxuICAnYmxhY2snIDogWzMwLCAzOV0sXG4gICdibHVlJyA6IFszNCwgMzldLFxuICAnY3lhbicgOiBbMzYsIDM5XSxcbiAgJ2dyZWVuJyA6IFszMiwgMzldLFxuICAnbWFnZW50YScgOiBbMzUsIDM5XSxcbiAgJ3JlZCcgOiBbMzEsIDM5XSxcbiAgJ3llbGxvdycgOiBbMzMsIDM5XVxufTtcblxuLy8gRG9uJ3QgdXNlICdibHVlJyBub3QgdmlzaWJsZSBvbiBjbWQuZXhlXG5pbnNwZWN0LnN0eWxlcyA9IHtcbiAgJ3NwZWNpYWwnOiAnY3lhbicsXG4gICdudW1iZXInOiAneWVsbG93JyxcbiAgJ2Jvb2xlYW4nOiAneWVsbG93JyxcbiAgJ3VuZGVmaW5lZCc6ICdncmV5JyxcbiAgJ251bGwnOiAnYm9sZCcsXG4gICdzdHJpbmcnOiAnZ3JlZW4nLFxuICAnZGF0ZSc6ICdtYWdlbnRhJyxcbiAgLy8gXCJuYW1lXCI6IGludGVudGlvbmFsbHkgbm90IHN0eWxpbmdcbiAgJ3JlZ2V4cCc6ICdyZWQnXG59O1xuXG5cbmZ1bmN0aW9uIHN0eWxpemVXaXRoQ29sb3Ioc3RyLCBzdHlsZVR5cGUpIHtcbiAgdmFyIHN0eWxlID0gaW5zcGVjdC5zdHlsZXNbc3R5bGVUeXBlXTtcblxuICBpZiAoc3R5bGUpIHtcbiAgICByZXR1cm4gJ1xcdTAwMWJbJyArIGluc3BlY3QuY29sb3JzW3N0eWxlXVswXSArICdtJyArIHN0ciArXG4gICAgICAgICAgICdcXHUwMDFiWycgKyBpbnNwZWN0LmNvbG9yc1tzdHlsZV1bMV0gKyAnbSc7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHN0cjtcbiAgfVxufVxuXG5cbmZ1bmN0aW9uIHN0eWxpemVOb0NvbG9yKHN0ciwgc3R5bGVUeXBlKSB7XG4gIHJldHVybiBzdHI7XG59XG5cblxuZnVuY3Rpb24gYXJyYXlUb0hhc2goYXJyYXkpIHtcbiAgdmFyIGhhc2ggPSB7fTtcblxuICBhcnJheS5mb3JFYWNoKGZ1bmN0aW9uKHZhbCwgaWR4KSB7XG4gICAgaGFzaFt2YWxdID0gdHJ1ZTtcbiAgfSk7XG5cbiAgcmV0dXJuIGhhc2g7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0VmFsdWUoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzKSB7XG4gIC8vIFByb3ZpZGUgYSBob29rIGZvciB1c2VyLXNwZWNpZmllZCBpbnNwZWN0IGZ1bmN0aW9ucy5cbiAgLy8gQ2hlY2sgdGhhdCB2YWx1ZSBpcyBhbiBvYmplY3Qgd2l0aCBhbiBpbnNwZWN0IGZ1bmN0aW9uIG9uIGl0XG4gIGlmIChjdHguY3VzdG9tSW5zcGVjdCAmJlxuICAgICAgdmFsdWUgJiZcbiAgICAgIGlzRnVuY3Rpb24odmFsdWUuaW5zcGVjdCkgJiZcbiAgICAgIC8vIEZpbHRlciBvdXQgdGhlIHV0aWwgbW9kdWxlLCBpdCdzIGluc3BlY3QgZnVuY3Rpb24gaXMgc3BlY2lhbFxuICAgICAgdmFsdWUuaW5zcGVjdCAhPT0gZXhwb3J0cy5pbnNwZWN0ICYmXG4gICAgICAvLyBBbHNvIGZpbHRlciBvdXQgYW55IHByb3RvdHlwZSBvYmplY3RzIHVzaW5nIHRoZSBjaXJjdWxhciBjaGVjay5cbiAgICAgICEodmFsdWUuY29uc3RydWN0b3IgJiYgdmFsdWUuY29uc3RydWN0b3IucHJvdG90eXBlID09PSB2YWx1ZSkpIHtcbiAgICB2YXIgcmV0ID0gdmFsdWUuaW5zcGVjdChyZWN1cnNlVGltZXMsIGN0eCk7XG4gICAgaWYgKCFpc1N0cmluZyhyZXQpKSB7XG4gICAgICByZXQgPSBmb3JtYXRWYWx1ZShjdHgsIHJldCwgcmVjdXJzZVRpbWVzKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbiAgfVxuXG4gIC8vIFByaW1pdGl2ZSB0eXBlcyBjYW5ub3QgaGF2ZSBwcm9wZXJ0aWVzXG4gIHZhciBwcmltaXRpdmUgPSBmb3JtYXRQcmltaXRpdmUoY3R4LCB2YWx1ZSk7XG4gIGlmIChwcmltaXRpdmUpIHtcbiAgICByZXR1cm4gcHJpbWl0aXZlO1xuICB9XG5cbiAgLy8gTG9vayB1cCB0aGUga2V5cyBvZiB0aGUgb2JqZWN0LlxuICB2YXIga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKTtcbiAgdmFyIHZpc2libGVLZXlzID0gYXJyYXlUb0hhc2goa2V5cyk7XG5cbiAgaWYgKGN0eC5zaG93SGlkZGVuKSB7XG4gICAga2V5cyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKHZhbHVlKTtcbiAgfVxuXG4gIC8vIElFIGRvZXNuJ3QgbWFrZSBlcnJvciBmaWVsZHMgbm9uLWVudW1lcmFibGVcbiAgLy8gaHR0cDovL21zZG4ubWljcm9zb2Z0LmNvbS9lbi11cy9saWJyYXJ5L2llL2R3dzUyc2J0KHY9dnMuOTQpLmFzcHhcbiAgaWYgKGlzRXJyb3IodmFsdWUpXG4gICAgICAmJiAoa2V5cy5pbmRleE9mKCdtZXNzYWdlJykgPj0gMCB8fCBrZXlzLmluZGV4T2YoJ2Rlc2NyaXB0aW9uJykgPj0gMCkpIHtcbiAgICByZXR1cm4gZm9ybWF0RXJyb3IodmFsdWUpO1xuICB9XG5cbiAgLy8gU29tZSB0eXBlIG9mIG9iamVjdCB3aXRob3V0IHByb3BlcnRpZXMgY2FuIGJlIHNob3J0Y3V0dGVkLlxuICBpZiAoa2V5cy5sZW5ndGggPT09IDApIHtcbiAgICBpZiAoaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICAgIHZhciBuYW1lID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoJ1tGdW5jdGlvbicgKyBuYW1lICsgJ10nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgICByZXR1cm4gY3R4LnN0eWxpemUoUmVnRXhwLnByb3RvdHlwZS50b1N0cmluZy5jYWxsKHZhbHVlKSwgJ3JlZ2V4cCcpO1xuICAgIH1cbiAgICBpZiAoaXNEYXRlKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKERhdGUucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwodmFsdWUpLCAnZGF0ZScpO1xuICAgIH1cbiAgICBpZiAoaXNFcnJvcih2YWx1ZSkpIHtcbiAgICAgIHJldHVybiBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgdmFyIGJhc2UgPSAnJywgYXJyYXkgPSBmYWxzZSwgYnJhY2VzID0gWyd7JywgJ30nXTtcblxuICAvLyBNYWtlIEFycmF5IHNheSB0aGF0IHRoZXkgYXJlIEFycmF5XG4gIGlmIChpc0FycmF5KHZhbHVlKSkge1xuICAgIGFycmF5ID0gdHJ1ZTtcbiAgICBicmFjZXMgPSBbJ1snLCAnXSddO1xuICB9XG5cbiAgLy8gTWFrZSBmdW5jdGlvbnMgc2F5IHRoYXQgdGhleSBhcmUgZnVuY3Rpb25zXG4gIGlmIChpc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgIHZhciBuID0gdmFsdWUubmFtZSA/ICc6ICcgKyB2YWx1ZS5uYW1lIDogJyc7XG4gICAgYmFzZSA9ICcgW0Z1bmN0aW9uJyArIG4gKyAnXSc7XG4gIH1cblxuICAvLyBNYWtlIFJlZ0V4cHMgc2F5IHRoYXQgdGhleSBhcmUgUmVnRXhwc1xuICBpZiAoaXNSZWdFeHAodmFsdWUpKSB7XG4gICAgYmFzZSA9ICcgJyArIFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGRhdGVzIHdpdGggcHJvcGVydGllcyBmaXJzdCBzYXkgdGhlIGRhdGVcbiAgaWYgKGlzRGF0ZSh2YWx1ZSkpIHtcbiAgICBiYXNlID0gJyAnICsgRGF0ZS5wcm90b3R5cGUudG9VVENTdHJpbmcuY2FsbCh2YWx1ZSk7XG4gIH1cblxuICAvLyBNYWtlIGVycm9yIHdpdGggbWVzc2FnZSBmaXJzdCBzYXkgdGhlIGVycm9yXG4gIGlmIChpc0Vycm9yKHZhbHVlKSkge1xuICAgIGJhc2UgPSAnICcgKyBmb3JtYXRFcnJvcih2YWx1ZSk7XG4gIH1cblxuICBpZiAoa2V5cy5sZW5ndGggPT09IDAgJiYgKCFhcnJheSB8fCB2YWx1ZS5sZW5ndGggPT0gMCkpIHtcbiAgICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArIGJyYWNlc1sxXTtcbiAgfVxuXG4gIGlmIChyZWN1cnNlVGltZXMgPCAwKSB7XG4gICAgaWYgKGlzUmVnRXhwKHZhbHVlKSkge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKFJlZ0V4cC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSksICdyZWdleHAnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmV0dXJuIGN0eC5zdHlsaXplKCdbT2JqZWN0XScsICdzcGVjaWFsJyk7XG4gICAgfVxuICB9XG5cbiAgY3R4LnNlZW4ucHVzaCh2YWx1ZSk7XG5cbiAgdmFyIG91dHB1dDtcbiAgaWYgKGFycmF5KSB7XG4gICAgb3V0cHV0ID0gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cyk7XG4gIH0gZWxzZSB7XG4gICAgb3V0cHV0ID0ga2V5cy5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICByZXR1cm4gZm9ybWF0UHJvcGVydHkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5LCBhcnJheSk7XG4gICAgfSk7XG4gIH1cblxuICBjdHguc2Vlbi5wb3AoKTtcblxuICByZXR1cm4gcmVkdWNlVG9TaW5nbGVTdHJpbmcob3V0cHV0LCBiYXNlLCBicmFjZXMpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdFByaW1pdGl2ZShjdHgsIHZhbHVlKSB7XG4gIGlmIChpc1VuZGVmaW5lZCh2YWx1ZSkpXG4gICAgcmV0dXJuIGN0eC5zdHlsaXplKCd1bmRlZmluZWQnLCAndW5kZWZpbmVkJyk7XG4gIGlmIChpc1N0cmluZyh2YWx1ZSkpIHtcbiAgICB2YXIgc2ltcGxlID0gJ1xcJycgKyBKU09OLnN0cmluZ2lmeSh2YWx1ZSkucmVwbGFjZSgvXlwifFwiJC9nLCAnJylcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXFxcXCIvZywgJ1wiJykgKyAnXFwnJztcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoc2ltcGxlLCAnc3RyaW5nJyk7XG4gIH1cbiAgaWYgKGlzTnVtYmVyKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ251bWJlcicpO1xuICBpZiAoaXNCb29sZWFuKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJycgKyB2YWx1ZSwgJ2Jvb2xlYW4nKTtcbiAgLy8gRm9yIHNvbWUgcmVhc29uIHR5cGVvZiBudWxsIGlzIFwib2JqZWN0XCIsIHNvIHNwZWNpYWwgY2FzZSBoZXJlLlxuICBpZiAoaXNOdWxsKHZhbHVlKSlcbiAgICByZXR1cm4gY3R4LnN0eWxpemUoJ251bGwnLCAnbnVsbCcpO1xufVxuXG5cbmZ1bmN0aW9uIGZvcm1hdEVycm9yKHZhbHVlKSB7XG4gIHJldHVybiAnWycgKyBFcnJvci5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh2YWx1ZSkgKyAnXSc7XG59XG5cblxuZnVuY3Rpb24gZm9ybWF0QXJyYXkoY3R4LCB2YWx1ZSwgcmVjdXJzZVRpbWVzLCB2aXNpYmxlS2V5cywga2V5cykge1xuICB2YXIgb3V0cHV0ID0gW107XG4gIGZvciAodmFyIGkgPSAwLCBsID0gdmFsdWUubGVuZ3RoOyBpIDwgbDsgKytpKSB7XG4gICAgaWYgKGhhc093blByb3BlcnR5KHZhbHVlLCBTdHJpbmcoaSkpKSB7XG4gICAgICBvdXRwdXQucHVzaChmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLFxuICAgICAgICAgIFN0cmluZyhpKSwgdHJ1ZSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvdXRwdXQucHVzaCgnJyk7XG4gICAgfVxuICB9XG4gIGtleXMuZm9yRWFjaChmdW5jdGlvbihrZXkpIHtcbiAgICBpZiAoIWtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIG91dHB1dC5wdXNoKGZvcm1hdFByb3BlcnR5KGN0eCwgdmFsdWUsIHJlY3Vyc2VUaW1lcywgdmlzaWJsZUtleXMsXG4gICAgICAgICAga2V5LCB0cnVlKSk7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIG91dHB1dDtcbn1cblxuXG5mdW5jdGlvbiBmb3JtYXRQcm9wZXJ0eShjdHgsIHZhbHVlLCByZWN1cnNlVGltZXMsIHZpc2libGVLZXlzLCBrZXksIGFycmF5KSB7XG4gIHZhciBuYW1lLCBzdHIsIGRlc2M7XG4gIGRlc2MgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHZhbHVlLCBrZXkpIHx8IHsgdmFsdWU6IHZhbHVlW2tleV0gfTtcbiAgaWYgKGRlc2MuZ2V0KSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW0dldHRlci9TZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RyID0gY3R4LnN0eWxpemUoJ1tHZXR0ZXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKGRlc2Muc2V0KSB7XG4gICAgICBzdHIgPSBjdHguc3R5bGl6ZSgnW1NldHRlcl0nLCAnc3BlY2lhbCcpO1xuICAgIH1cbiAgfVxuICBpZiAoIWhhc093blByb3BlcnR5KHZpc2libGVLZXlzLCBrZXkpKSB7XG4gICAgbmFtZSA9ICdbJyArIGtleSArICddJztcbiAgfVxuICBpZiAoIXN0cikge1xuICAgIGlmIChjdHguc2Vlbi5pbmRleE9mKGRlc2MudmFsdWUpIDwgMCkge1xuICAgICAgaWYgKGlzTnVsbChyZWN1cnNlVGltZXMpKSB7XG4gICAgICAgIHN0ciA9IGZvcm1hdFZhbHVlKGN0eCwgZGVzYy52YWx1ZSwgbnVsbCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdHIgPSBmb3JtYXRWYWx1ZShjdHgsIGRlc2MudmFsdWUsIHJlY3Vyc2VUaW1lcyAtIDEpO1xuICAgICAgfVxuICAgICAgaWYgKHN0ci5pbmRleE9mKCdcXG4nKSA+IC0xKSB7XG4gICAgICAgIGlmIChhcnJheSkge1xuICAgICAgICAgIHN0ciA9IHN0ci5zcGxpdCgnXFxuJykubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgICAgICAgIHJldHVybiAnICAnICsgbGluZTtcbiAgICAgICAgICB9KS5qb2luKCdcXG4nKS5zdWJzdHIoMik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3RyID0gJ1xcbicgKyBzdHIuc3BsaXQoJ1xcbicpLm1hcChmdW5jdGlvbihsaW5lKSB7XG4gICAgICAgICAgICByZXR1cm4gJyAgICcgKyBsaW5lO1xuICAgICAgICAgIH0pLmpvaW4oJ1xcbicpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0ciA9IGN0eC5zdHlsaXplKCdbQ2lyY3VsYXJdJywgJ3NwZWNpYWwnKTtcbiAgICB9XG4gIH1cbiAgaWYgKGlzVW5kZWZpbmVkKG5hbWUpKSB7XG4gICAgaWYgKGFycmF5ICYmIGtleS5tYXRjaCgvXlxcZCskLykpIHtcbiAgICAgIHJldHVybiBzdHI7XG4gICAgfVxuICAgIG5hbWUgPSBKU09OLnN0cmluZ2lmeSgnJyArIGtleSk7XG4gICAgaWYgKG5hbWUubWF0Y2goL15cIihbYS16QS1aX11bYS16QS1aXzAtOV0qKVwiJC8pKSB7XG4gICAgICBuYW1lID0gbmFtZS5zdWJzdHIoMSwgbmFtZS5sZW5ndGggLSAyKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnbmFtZScpO1xuICAgIH0gZWxzZSB7XG4gICAgICBuYW1lID0gbmFtZS5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIilcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xcXFxcIi9nLCAnXCInKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvKF5cInxcIiQpL2csIFwiJ1wiKTtcbiAgICAgIG5hbWUgPSBjdHguc3R5bGl6ZShuYW1lLCAnc3RyaW5nJyk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG5hbWUgKyAnOiAnICsgc3RyO1xufVxuXG5cbmZ1bmN0aW9uIHJlZHVjZVRvU2luZ2xlU3RyaW5nKG91dHB1dCwgYmFzZSwgYnJhY2VzKSB7XG4gIHZhciBudW1MaW5lc0VzdCA9IDA7XG4gIHZhciBsZW5ndGggPSBvdXRwdXQucmVkdWNlKGZ1bmN0aW9uKHByZXYsIGN1cikge1xuICAgIG51bUxpbmVzRXN0Kys7XG4gICAgaWYgKGN1ci5pbmRleE9mKCdcXG4nKSA+PSAwKSBudW1MaW5lc0VzdCsrO1xuICAgIHJldHVybiBwcmV2ICsgY3VyLnJlcGxhY2UoL1xcdTAwMWJcXFtcXGRcXGQ/bS9nLCAnJykubGVuZ3RoICsgMTtcbiAgfSwgMCk7XG5cbiAgaWYgKGxlbmd0aCA+IDYwKSB7XG4gICAgcmV0dXJuIGJyYWNlc1swXSArXG4gICAgICAgICAgIChiYXNlID09PSAnJyA/ICcnIDogYmFzZSArICdcXG4gJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBvdXRwdXQuam9pbignLFxcbiAgJykgK1xuICAgICAgICAgICAnICcgK1xuICAgICAgICAgICBicmFjZXNbMV07XG4gIH1cblxuICByZXR1cm4gYnJhY2VzWzBdICsgYmFzZSArICcgJyArIG91dHB1dC5qb2luKCcsICcpICsgJyAnICsgYnJhY2VzWzFdO1xufVxuXG5cbi8vIE5PVEU6IFRoZXNlIHR5cGUgY2hlY2tpbmcgZnVuY3Rpb25zIGludGVudGlvbmFsbHkgZG9uJ3QgdXNlIGBpbnN0YW5jZW9mYFxuLy8gYmVjYXVzZSBpdCBpcyBmcmFnaWxlIGFuZCBjYW4gYmUgZWFzaWx5IGZha2VkIHdpdGggYE9iamVjdC5jcmVhdGUoKWAuXG5mdW5jdGlvbiBpc0FycmF5KGFyKSB7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KGFyKTtcbn1cbmV4cG9ydHMuaXNBcnJheSA9IGlzQXJyYXk7XG5cbmZ1bmN0aW9uIGlzQm9vbGVhbihhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdib29sZWFuJztcbn1cbmV4cG9ydHMuaXNCb29sZWFuID0gaXNCb29sZWFuO1xuXG5mdW5jdGlvbiBpc051bGwoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IG51bGw7XG59XG5leHBvcnRzLmlzTnVsbCA9IGlzTnVsbDtcblxuZnVuY3Rpb24gaXNOdWxsT3JVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNOdWxsT3JVbmRlZmluZWQgPSBpc051bGxPclVuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNOdW1iZXIoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnbnVtYmVyJztcbn1cbmV4cG9ydHMuaXNOdW1iZXIgPSBpc051bWJlcjtcblxuZnVuY3Rpb24gaXNTdHJpbmcoYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3RyaW5nJztcbn1cbmV4cG9ydHMuaXNTdHJpbmcgPSBpc1N0cmluZztcblxuZnVuY3Rpb24gaXNTeW1ib2woYXJnKSB7XG4gIHJldHVybiB0eXBlb2YgYXJnID09PSAnc3ltYm9sJztcbn1cbmV4cG9ydHMuaXNTeW1ib2wgPSBpc1N5bWJvbDtcblxuZnVuY3Rpb24gaXNVbmRlZmluZWQoYXJnKSB7XG4gIHJldHVybiBhcmcgPT09IHZvaWQgMDtcbn1cbmV4cG9ydHMuaXNVbmRlZmluZWQgPSBpc1VuZGVmaW5lZDtcblxuZnVuY3Rpb24gaXNSZWdFeHAocmUpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KHJlKSAmJiBvYmplY3RUb1N0cmluZyhyZSkgPT09ICdbb2JqZWN0IFJlZ0V4cF0nO1xufVxuZXhwb3J0cy5pc1JlZ0V4cCA9IGlzUmVnRXhwO1xuXG5mdW5jdGlvbiBpc09iamVjdChhcmcpIHtcbiAgcmV0dXJuIHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyAhPT0gbnVsbDtcbn1cbmV4cG9ydHMuaXNPYmplY3QgPSBpc09iamVjdDtcblxuZnVuY3Rpb24gaXNEYXRlKGQpIHtcbiAgcmV0dXJuIGlzT2JqZWN0KGQpICYmIG9iamVjdFRvU3RyaW5nKGQpID09PSAnW29iamVjdCBEYXRlXSc7XG59XG5leHBvcnRzLmlzRGF0ZSA9IGlzRGF0ZTtcblxuZnVuY3Rpb24gaXNFcnJvcihlKSB7XG4gIHJldHVybiBpc09iamVjdChlKSAmJlxuICAgICAgKG9iamVjdFRvU3RyaW5nKGUpID09PSAnW29iamVjdCBFcnJvcl0nIHx8IGUgaW5zdGFuY2VvZiBFcnJvcik7XG59XG5leHBvcnRzLmlzRXJyb3IgPSBpc0Vycm9yO1xuXG5mdW5jdGlvbiBpc0Z1bmN0aW9uKGFyZykge1xuICByZXR1cm4gdHlwZW9mIGFyZyA9PT0gJ2Z1bmN0aW9uJztcbn1cbmV4cG9ydHMuaXNGdW5jdGlvbiA9IGlzRnVuY3Rpb247XG5cbmZ1bmN0aW9uIGlzUHJpbWl0aXZlKGFyZykge1xuICByZXR1cm4gYXJnID09PSBudWxsIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnYm9vbGVhbicgfHxcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICdudW1iZXInIHx8XG4gICAgICAgICB0eXBlb2YgYXJnID09PSAnc3RyaW5nJyB8fFxuICAgICAgICAgdHlwZW9mIGFyZyA9PT0gJ3N5bWJvbCcgfHwgIC8vIEVTNiBzeW1ib2xcbiAgICAgICAgIHR5cGVvZiBhcmcgPT09ICd1bmRlZmluZWQnO1xufVxuZXhwb3J0cy5pc1ByaW1pdGl2ZSA9IGlzUHJpbWl0aXZlO1xuXG5leHBvcnRzLmlzQnVmZmVyID0gcmVxdWlyZSgnLi9zdXBwb3J0L2lzQnVmZmVyJyk7XG5cbmZ1bmN0aW9uIG9iamVjdFRvU3RyaW5nKG8pIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChvKTtcbn1cblxuXG5mdW5jdGlvbiBwYWQobikge1xuICByZXR1cm4gbiA8IDEwID8gJzAnICsgbi50b1N0cmluZygxMCkgOiBuLnRvU3RyaW5nKDEwKTtcbn1cblxuXG52YXIgbW9udGhzID0gWydKYW4nLCAnRmViJywgJ01hcicsICdBcHInLCAnTWF5JywgJ0p1bicsICdKdWwnLCAnQXVnJywgJ1NlcCcsXG4gICAgICAgICAgICAgICdPY3QnLCAnTm92JywgJ0RlYyddO1xuXG4vLyAyNiBGZWIgMTY6MTk6MzRcbmZ1bmN0aW9uIHRpbWVzdGFtcCgpIHtcbiAgdmFyIGQgPSBuZXcgRGF0ZSgpO1xuICB2YXIgdGltZSA9IFtwYWQoZC5nZXRIb3VycygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0TWludXRlcygpKSxcbiAgICAgICAgICAgICAgcGFkKGQuZ2V0U2Vjb25kcygpKV0uam9pbignOicpO1xuICByZXR1cm4gW2QuZ2V0RGF0ZSgpLCBtb250aHNbZC5nZXRNb250aCgpXSwgdGltZV0uam9pbignICcpO1xufVxuXG5cbi8vIGxvZyBpcyBqdXN0IGEgdGhpbiB3cmFwcGVyIHRvIGNvbnNvbGUubG9nIHRoYXQgcHJlcGVuZHMgYSB0aW1lc3RhbXBcbmV4cG9ydHMubG9nID0gZnVuY3Rpb24oKSB7XG4gIGNvbnNvbGUubG9nKCclcyAtICVzJywgdGltZXN0YW1wKCksIGV4cG9ydHMuZm9ybWF0LmFwcGx5KGV4cG9ydHMsIGFyZ3VtZW50cykpO1xufTtcblxuXG4vKipcbiAqIEluaGVyaXQgdGhlIHByb3RvdHlwZSBtZXRob2RzIGZyb20gb25lIGNvbnN0cnVjdG9yIGludG8gYW5vdGhlci5cbiAqXG4gKiBUaGUgRnVuY3Rpb24ucHJvdG90eXBlLmluaGVyaXRzIGZyb20gbGFuZy5qcyByZXdyaXR0ZW4gYXMgYSBzdGFuZGFsb25lXG4gKiBmdW5jdGlvbiAobm90IG9uIEZ1bmN0aW9uLnByb3RvdHlwZSkuIE5PVEU6IElmIHRoaXMgZmlsZSBpcyB0byBiZSBsb2FkZWRcbiAqIGR1cmluZyBib290c3RyYXBwaW5nIHRoaXMgZnVuY3Rpb24gbmVlZHMgdG8gYmUgcmV3cml0dGVuIHVzaW5nIHNvbWUgbmF0aXZlXG4gKiBmdW5jdGlvbnMgYXMgcHJvdG90eXBlIHNldHVwIHVzaW5nIG5vcm1hbCBKYXZhU2NyaXB0IGRvZXMgbm90IHdvcmsgYXNcbiAqIGV4cGVjdGVkIGR1cmluZyBib290c3RyYXBwaW5nIChzZWUgbWlycm9yLmpzIGluIHIxMTQ5MDMpLlxuICpcbiAqIEBwYXJhbSB7ZnVuY3Rpb259IGN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gd2hpY2ggbmVlZHMgdG8gaW5oZXJpdCB0aGVcbiAqICAgICBwcm90b3R5cGUuXG4gKiBAcGFyYW0ge2Z1bmN0aW9ufSBzdXBlckN0b3IgQ29uc3RydWN0b3IgZnVuY3Rpb24gdG8gaW5oZXJpdCBwcm90b3R5cGUgZnJvbS5cbiAqL1xuZXhwb3J0cy5pbmhlcml0cyA9IHJlcXVpcmUoJ2luaGVyaXRzJyk7XG5cbmV4cG9ydHMuX2V4dGVuZCA9IGZ1bmN0aW9uKG9yaWdpbiwgYWRkKSB7XG4gIC8vIERvbid0IGRvIGFueXRoaW5nIGlmIGFkZCBpc24ndCBhbiBvYmplY3RcbiAgaWYgKCFhZGQgfHwgIWlzT2JqZWN0KGFkZCkpIHJldHVybiBvcmlnaW47XG5cbiAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhhZGQpO1xuICB2YXIgaSA9IGtleXMubGVuZ3RoO1xuICB3aGlsZSAoaS0tKSB7XG4gICAgb3JpZ2luW2tleXNbaV1dID0gYWRkW2tleXNbaV1dO1xuICB9XG4gIHJldHVybiBvcmlnaW47XG59O1xuXG5mdW5jdGlvbiBoYXNPd25Qcm9wZXJ0eShvYmosIHByb3ApIHtcbiAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChvYmosIHByb3ApO1xufVxuIl19
