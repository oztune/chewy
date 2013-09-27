/*
We can make this more configurable:
- Specify the different types of lists (right now they're hardcoded as todo, doing, testing, done)
- Specify the name of each list in the board
- Specify default point values for cards (right now 0)
- What to do with cards that are unassigned? (right now ignored)

- I think that planned/unplanned should be hard-coded
*/

(function () {
    'use strict';

    angular.module('chewy', [])
    .factory('trello', function ($rootScope, $q) {
        var trello,
            authorized = $q.defer(),
            ready = $q.defer(),
            cache,
            useCache = true,
            cacheAll = false;

        // Calculate board id => details hash
        function getBoards() {
            return trello.rest('GET', '/members/me', null, true).then(function (data) {
                return $q.all($.map(data.idBoards, function (id) {
                    return trello.rest('GET', '/boards/' + id, null, true);
                })).then(function (boards) {
                    var mapping = {};
                    $.each(boards, function (i, board) {
                        mapping[board.id] = board;
                    });
                    return mapping;
                });
            });
        }

        // Init. Preloads things that are always needed
        authorized.promise.then(function () {
            getBoards().then(function (boards) {
                trello.boards = boards;
                ready.resolve();
            });
        });

        cache = (useCache || cacheAll) ? JSON.parse(localStorage.getItem('cache') || '{}') : {};
        function cacheGet(key) {
            return cache[key];
        }
        function cacheSet(key, value) {
            cache[key] = value;
            localStorage.setItem('cache', JSON.stringify(cache));
        }

        trello = {
            rest: function rest(method, path, params, cacheResult) {
                var deferred = $q.defer(),
                    cacheId = method + '_' + path;

                if (cacheAll) cacheResult = true;

                if (cacheGet(cacheId) !== undefined) {
                    deferred.resolve(cacheGet(cacheId));
                } else {
                    Trello.rest(method, path, params, function (data, status, request) {
                        if (cacheResult) cacheSet(cacheId, data);
                        deferred.resolve(data);
                    }, function () {
                        deferred.reject();
                    });
                }

                return deferred.promise;
            },
            authorize: function () {
                var deferred = $q.defer();
                Trello.authorize({
                    type: 'popup',
                    name: 'Chewy by appFigures',
                    scope: {
                        read: true
                    },
                    success: function () {
                        if ($rootScope.$$digest) $rootScope.$apply();
                        authorized.resolve();
                        deferred.resolve();
                    },
                    error: function () {
                        if ($rootScope.$$digest) $rootScope.$apply();
                        deferred.reject();
                    }
                });
                return deferred.promise;
            },
            ready: ready.promise,

            // Helpers
            getBoardLists: function (boardId) {
                return trello.rest('GET', '/boards/' + boardId + '/lists');
            },
            getBoardMembers: function (boardId) {
                return trello.rest('GET', '/boards/' + boardId + '/members');
            },
            getMember: function (memberId) {
                return trello.rest('GET', '/members/' + memberId);
            },
            getListCards: function (listId) {
                return trello.rest('GET', '/lists/' + listId + '/cards');
            },
            getCardChecklists: function (cardId) {
                return trello.rest('GET', '/cards/' + cardId + '/checklists');
            }
        };

        return trello;
    })
    .factory('dataHelper', function (trello, $q, progressUtils, Progress) {
        var requiredLists = ['Doing', 'Testing', 'Done'],
            minNumLists = 4;

        return {
            calc: function (boardId) {
                return trello.ready.then(function () {
                    var board = trello.boards[boardId];

                    if (!board) throw 'Board "' + boardId + '" doesn\'t exist';

                    // Grab all the data about the board
                    return $q.all([
                        // Get all the lists in the board
                        trello.getBoardLists(board.id).then(function(lists) {
                            // Sanity tests
                            $.each(requiredLists, function (i, name) {
                                // TODO: Test here
                            });
                            if (lists.length < minNumLists) throw 'Board ' + board.name + ' doesn\'t have enough lists';
                            
                            // Grab the cards for each list
                            return $q.all($.map(lists, function (list) {
                                return trello.getListCards(list.id);
                            })).then(function (listsCards) {
                                var allCards;

                                $.each(lists, function (i, list) {
                                    list.cards = listsCards[i];
                                });

                                // Grab the checklists for each card
                                allCards = $.map(listsCards, function (cards) {
                                    return cards;
                                });
                                return $q.all($.map(allCards, function (card) {
                                    return trello.getCardChecklists(card.id);
                                }))
                                .then(function (checklists) {
                                    $.each(allCards, function (i, card) {
                                        card.checklists = checklists[i];
                                    });
                                    return lists;
                                });
                            });
                        }),
                        trello.getBoardMembers(board.id).then(function (members) {
                            // Get more info about each member
                            return $q.all($.map(members, function (member) {
                                return trello.getMember(member.id);
                            }));
                        })
                    ])
                    .then(function (data) {
                        var lists = data[0],
                            members = data[1];

                        return transform(lists, members);
                    });
                });
            }
        };

        function transform (lists, members) {
            var data = {};

            data.iterationName = lists[0].name;
            data.members = members;

            function getList(name) {
                var out = null;
                $.each(lists, function (i, list) {
                    if (list.name === name) out = list;
                });

                return out;
            }

            // Calculate all the cards each member is doing
            $.each({
                'todo': lists[0],
                'doing': getList('Doing'),
                'testing': getList('Testing'),
                'done': getList('Done')
            }, function (varName, list) {
                if (!list) throw 'No list for ' + varName;
                $.each(members, function (i, member) {
                    member.chewy = member.chewy || {};
                    member.chewy[varName] = $.map(list.cards, function (card) {
                        if ($.inArray(member.id, card.idMembers) >= 0) {
                            return card;
                        }
                    });
                });
            });
            
            // For the templating
            data.progress = {
                planned: new Progress(),
                unplanned: new Progress()
            };

            $.each(members, function (i, member) {
                member.doingNames = $.map(member.chewy.doing, function (card) {
                    return card.name;
                });
                member.progress = progressUtils.calcMemberProgress(member.chewy);

                data.progress.planned.merge(member.progress.planned);
                data.progress.unplanned.merge(member.progress.unplanned);
            });

            return data;
        }
    })
    .factory('Progress', function () {
        function Progress () {
            var that = this;
            $.each(Progress.attrs, function (i, key) {
                that[key] = 0;
            });
        }

        // The order is used by the progress bar
        Progress.attrs = ['done', 'testing', 'doing', 'todo'];
        Progress.prototype = {
            total: function () {
                var that = this,
                    total = 0;
                $.each(Progress.attrs, function (i, key) {
                    total += that[key];
                });

                return total;
            },
            clone: function () {
                return (new Progress()).merge(this);
            },
            merge: function (progress, multiplier) {
                var that = this;
                if (typeof multiplier !== 'number') multiplier = 1.0;

                $.each(Progress.attrs, function (i, key) {
                    that[key] += progress[key] * multiplier;
                });

                return this;
            }
        };

        return Progress;
    })
    .factory('progressUtils', function (Progress) {
        // Parsing points out of checklist item name
        var parsePattern = /^\[(\d+\.*\d*) *(->)? *(\d+\.*\d*)?\]/;

        // These two functions are where the points calculations get done

        // Given a card and the list its in (todo, doing, testing, done)
        // calculates its progress object.

        // @param unplannedToggle
        //      If true only unplanned items are used.
        //      If false only planned items are used.

        // Note: If a card is done, all of its items are counted
        // as done, even if they're not checked off.
        // Only cards in doing take the state of the check item into
        // account.
        function calcCardProgress(card, listType, unplannedToggle) {
            var progress = new Progress();

            // For testing boards that aren't marked properly
            // if (true) {
            //     if (!unplannedToggle) {
            //         progress[listType] = 1;
            //     }
            //     return progress;
            // }

            $.each(card.checklists, function (i, checklist) {
                var listPoints = calcChecklistPoints(checklist, unplannedToggle),
                    total = listPoints.complete + listPoints.incomplete;

                if (listType === 'todo') {
                    progress.todo += total;
                } else if (listType === 'doing') {
                    progress.doing += listPoints.incomplete;
                    progress.testing += listPoints.complete;
                } else if (listType === 'testing') {
                    progress.testing += total;
                } else if (listType === 'done') {
                    progress.done += total;
                }
            });

            return progress;
        }

        // Given a checklist, figures out how many points are
        // complete, how many are incomplete
        //
        // Returns {complete: number, incomplete: number}
        function calcChecklistPoints(checklist, unplannedToggle) {
            var out = {
                complete: 0,
                incomplete: 0
            };

            $.each(checklist.checkItems, function (i, item) {
                var points = parseItemPoints(item.name);

                if (points.unplanned !== unplannedToggle) return;

                // We count the points the iteration started with
                // not what they morphed to.
                out[item.state] += points.start;
            });

            return out;
        }

        // Utils

        // TODO: Write a test for this method
        // Parse points of out checklist item name
        // ex:
        //      [1] asdasd      => {start: 1, end: 1, unplanned: false}
        //      [2->1] asdasd   => {start: 2, end: 1, unplanned: false}
        //      * [0.5] asdasd   => {start: 0.5, end: 0.5, unplanned: true}
        function parseItemPoints(itemName) {
            var unplanned = false, match, start;

            itemName = $.trim(itemName);

            if (itemName.charAt(0) === '*') {
                unplanned = true;
                itemName = $.trim(itemName.substr(1));
            }

            match = parsePattern.exec(itemName) || [];
            start = parseFloat(match[1]) || 0;

            return {
                start: start,
                end: parseFloat(match[3]) || start,
                unplanned: unplanned
            };
        }

        return {
            // @param memberCards {'doing': [cards], 'testing': [cards], ...}
            //  todo
            //  doing
            //  testing
            //  done
            calcMemberProgress: function (memberCards) {
                var plannedProgress = new Progress(),
                    unplannedProgress = new Progress();

                $.each(memberCards, function (cardsType, cards) {
                    $.each(cards, function (i, card) {
                        var cardPlannedProgress = calcCardProgress(card, cardsType, false),
                            cardUnplannedProgress = calcCardProgress(card, cardsType, true);

                        // TODO: If a card is owned by several members
                        // right now each member gets the total points.
                        // AKA if a card is 10 points and 3 people are on it,
                        // it adds 30 extra points to the project.
                        //
                        // Optionally this could be done to split the
                        // points evenly.
                        // var multiplier = 1 / card.idMembers.length;
                        // plannedProgress.merge(cardPlannedProgress, multiplier);
                        // unplannedProgress.merge(cardUnplannedProgress, multiplier);

                        plannedProgress.merge(cardPlannedProgress);
                        unplannedProgress.merge(cardUnplannedProgress);

                    });
                });

                return {
                    planned: plannedProgress,
                    unplanned: unplannedProgress
                };
            }
        };
    })
    .filter('avatar', function () {
        return function (hash, size) {
            if (!hash) return null;
            size = size || 30;
            return 'https://trello-avatars.s3.amazonaws.com/' + hash + '/' + size + '.png';
        };
    })
    .filter('percent', function () {
        return function (value, sigDigits) {
            value = value * 100;

            if (sigDigits != null) {
                value = value.toPrecision(sigDigits);
            }
            return value + '%';
        };
    })
    .directive('progressbar', function (Progress) {
        function percent(amount, total) {
            return total > 0 ? amount / total : 0;
        }

        // Order matters for view
        var types = ['unplanned', 'planned'];

        return {
            restrict: 'A',
            template: '' +
                '<div class="total-planned" style="width: {{planned.percent|percent}}"></div>' +
                '<div class="segments">' +
                    '<div ng-repeat="segment in segments" ' +
                        'ng-hide="segment.percent < 0.00000001" ' +
                        'title="{{segment.list}} ({{segment.type}}) - {{segment.points}} points ({{segment.percent|percent:2}})" ' +
                        'style="width: {{segment.percent|percent}}" ' +
                        'class="segment list-{{segment.list}} type-{{segment.type}}">' +
                    '</div>' +
                '</div>' +
                '<div class="total-planned-marker" style="left: {{planned.percent|percent}}" ng-hide="planned.percent > 0.99999"></div>' +
            '',
            link: function (scope, el, attrs) {
                scope.segments = [];
                scope.$watch(attrs.progressbar, function (data) {

                    var plannedTotal = data.planned.total(),
                        grandTotal = plannedTotal + data.unplanned.total();

                    // [todo, doing, testing, done]
                    $.each(Progress.attrs, function (i, attr) {
                        $.each(types, function (i, type) {
                            var progress = data[type];
                            scope.segments.push({
                                percent: percent(progress[attr], grandTotal),
                                list: attr,
                                type: type,
                                points: progress[attr]
                            });
                        });
                    });

                    scope.planned = {
                        percent: percent(plannedTotal, grandTotal),
                        points: plannedTotal
                    };
                });
            }
        };
    })
    .controller('main', function ($scope, trello) {
        $scope.state = 'unauthorized';

        $scope.authorize = function () {
            trello.authorize();

            trello.ready.then(function () {
                $scope.state = 'authorized';
                $scope.boards = $.map(trello.boards, function (board) {
                    return board;
                });
            });
        };
    })
    .controller('dashboard', function ($scope, dataHelper) {
        $scope.boardId = $scope.boards[0].id;

        $scope.$watch('boardId', function (value) {
            if (!value) return;

            $scope.state = 'loading';
            dataHelper.calc(value).then(function (data) {
                console.log('final data', data);
                $scope.state = 'active';
                $scope.data = data;
            }, function () {
                $scope.state = 'error';
            });
        });
    });
}());