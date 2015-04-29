var types = require('../domains/types')
var walk = require('acorn/util/walk');

// status:
// { self  : AVal, 
//   ret   : AVal, 
//   exc   : AVal, 
//   delta : Context,
//   sc    : ScopeChain }

// arguments are " oldStatus (, name, val)* "
function changedStatus(oldStatus) {
    var newStatus = Object.create(null);
    for (var i = 1; i < arguments.length; i = i + 2)
        newStatus[arguments[i]] = arguments[i+1];

    for (var p in oldStatus) {
        if (newStatus[p] === undefined) 
            newStatus[p] = oldStatus[p];
    }
    return newStatus;
}

var constraints;

function getConstraints(ast, gScope) {
    // temporal set for generated constraints.
    constraints = [];

    recursiveWithReturn(ast, gScope, constraintGenerator);

    return constraints;
}

// constraint generating walker for expressions
var constraintGenerator = walk.make({

    Identifier: function (node, curStatus, c) {
        return curStatus.sc.getAValOf(node.name);
    },
    
    ThisExpression: function (node, curStatus, c) {
        return curStatus.self;  
    },

    Literal: function (node, curStatus, c) {
        var res = new types.AVal;
        if (node.regex) {
            // not implemented yet
            // throw new Error('regex literal is not implemented yet');
            return res;
        }
        switch (typeof node.value) {
        case 'number':
            res.addType(types.PrimNumber);
            break;
        case 'string':
            res.addType(types.PrimString);
            break;
        case 'boolean':
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

    AssignmentExpression: function (node, curStatus, c) {
        if (node.left.type === 'MemberExpression') {
            // TODO
            // LHS is not a simple variable.
        } else {
            // LHS is a simple variable.
            var varName = node.left.name;
            var lhsAVal = curStatus.sc.getAValOf(varName);
            var rhsAVal = c(node.right, curStatus, undefined);
            constraints.push({FROM: rhsAVal,
                              TO: lhsAVal});
            // corresponding AVal is the RHS
            return rhsAVal;
        }
    },
    VariableDeclaration: function (node, curStatus, c) {
        for (var i = 0; i < node.declarations.length; i++) {
            var decl = node.declarations[i];
            if (decl.init) {
                var lhsAVal = curStatus.sc.getAValOf(decl.id.name);
                var rhsAVal = c(decl.init, curStatus, undefined);
                constraints.push({FROM: rhsAVal,
                                  TO: lhsAVal});
            }
        }
    },

    LogicalExpression: function (node, curStatus, c) {
        var res = new types.AVal;
        var left = c(node.left, curStatus, undefined);
        var right = c(node.right, curStatus, undefined);
        constraints.push({FROM: left, TO: res},
                         {FROM: right, TO: res});
        return res;
    },

    ConditionalExpression: function (node, curStatus, c) {
        var res = new types.AVal;
        c(node.test, curStatus, undefined);
        var cons = c(node.consequent, curStatus, undefined);
        var alt = c(node.alternate, curStatus, undefined);
        constraints.push({FROM: cons, TO: res},
                         {FROM: alt, TO: res});
        return res;
    },
    
    FunctionDeclaration: function (node, curStatus, c) {
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
            fnInstance 
                = new types.FnType(node.id.name, 
                                   node.body['@block'].getParamVarNames(), 
                                   sc0);
            node.fnInstances.push(fnInstance);
        }
        var lhsAVal = sc0.getAValOf(node.id.name);
        constraints.push({TYPE: fnInstance,
                          INCL_SET: lhsAVal});
        // nothing to return
        return types.AValNull;
    },
    
    CallExpression: function (node, curStatus, c) {
        var resAVal = new types.AVal;
        var argsAVal = [];
        
        // get AVals for each arguments
        for (var i = 0; i < node.arguments.length; i++) {
            argsAVal.push(
                c(node.arguments[i], curStatus, undefined));
        }

        if (node.callee.type === 'MemberExpression') {

            // TODO: method call
        } else {
            // normal function call
            var calleeAVal = c(node.callee, curStatus, undefined);
            
            // callee에 함수 값이 추가될 경우,
            // 현재 call expression의 this, parameter를 함수 안으로
            // callee의 return을 call expression으로
            // callee의 exception을 호출 측의 exception에 전달해야
            constraints.push({
                CALLEE: calleeAVal,
                SELF: types.AValNull, // TODO: use global object
                PARAMS: argsAVal,
                RET: resAVal,
                EXC: curStatus.exc
            });
        }
        return resAVal;
    }
});


function recursiveWithReturn(node, state, visitor) {
    function c(node, st, override) {
        return visitor[override || node.type](node, st, c);
    }
    return c(node, state);
}

exports.getConstraints = getConstraints;