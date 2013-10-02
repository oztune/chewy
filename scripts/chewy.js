/*
We can make this more configurable:
- Specify the different types of lists (right now they're hardcoded as todo, doing, testing, done)
- Specify the name of each list in the board
- Specify default point values for cards (right now 0)
- What to do with cards that are unassigned? (right now ignored)

- I think that planned/unplanned should be hard-coded
*/

// Globals
var interval = 5000;
var debugMode = false;

var globals = {
    listPatterns: {
        'todo': /todo/i,
        'doing': /doing/i,
        'testing': /testing/i,
        'done': /done/i
    }
};

(function () {
    'use strict';

    angular.module('chewy', [])
    .factory('trello', function ($rootScope, $q, storage) {
        var trello,
            authorized = $q.defer(),
            ready = $q.defer(),
            cache,
            persistCache = true && debugMode,
            cacheAll = true && debugMode;

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

        cache = persistCache ? storage.get('cache') || {} : {};
        function cacheGet(key) {
            return cache[key];
        }
        function cacheSet(key, value) {
            cache[key] = value;
            if (persistCache) storage.set('cache', cache);
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
                    //type: 'popup',
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
    .factory('storage', function () {
        return {
            get: function (key) {
                var value = localStorage.getItem(key);
                if (typeof value !== 'string') return;
                if (value === 'undefined') return;
                return JSON.parse(value);
            },
            set: function (key, value) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        };
    })
    .factory('dataHelper', function (trello, $q, progressUtils, Progress) {
        var parsePattern = /^\((\d+\.*\d*) *(->)? *(\d+\.*\d*)?\)/;

        return {
            calc: function (boardId) {
                return trello.ready.then(function () {
                    var board = trello.boards[boardId];

                    if (!board) throw 'Board "' + boardId + '" doesn\'t exist';

                    // Grab all the data about the board
                    return $q.all([
                        // Get all the lists in the board
                        trello.getBoardLists(board.id).then(function(lists) {
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

        // Utils

        // TODO: Write a test for this method
        // Parse meta data out of name
        // ex:
        //      [1] asdasd      => {start: 1, end: 1, unplanned: false}
        //      [2->1] asdasd   => {start: 2, end: 1, unplanned: false}
        //      * [0.5] asdasd   => {start: 0.5, end: 0.5, unplanned: true}
        function parseMetaFromName(name) {
            var unplanned = false, match, start;

            name = $.trim(name);

            if (name.charAt(0) === '*') {
                unplanned = true;
                name = $.trim(name.substr(1));
            }

            match = parsePattern.exec(name) || [];
            start = parseFloat(match[1]) || 0;

            if (match.length <= 0) return null;

            return {
                start: start,
                end: parseFloat(match[3]) || start,
                unplanned: unplanned,
                getPoints: function (unplannedToggle) {

                    // Old way:
                    // if (unplannedToggle !== this.unplanned) return 0;
                    // return this.start;

                    // New way: Count extra points as unplanned
                    var plannedPoints, unplannedPoints;

                    if (this.unplanned) {
                        plannedPoints = 0;
                        unplannedPoints = this.end;
                    } else {
                        plannedPoints = this.start;
                        unplannedPoints = Math.max(this.end - this.start, 0);
                    }

                    return unplannedToggle ? unplannedPoints : plannedPoints;
                }
            };
        }

        function transform (lists, members) {
            var data = {};

            function getList(name) {
                var exp = globals.listPatterns[name],
                    out = null;

                if (!exp) return null;

                $.each(lists, function (i, list) {
                    //if (list.name === name) out = list;
                    if (exp.test(list.name)) {
                        out = list;
                        return false;
                    }
                });

                return out;
            }

            function calcMeta(item) {
                item.meta = parseMetaFromName(item.name);
            }

            // Get the meta-data out of each card/checklist/list
            $.each(Progress.attrs, function (i, listType) {
                var list = getList(listType);
                if (!list) return;

                $.each(list.cards, function (i, card) {
                    calcMeta(card);

                    $.each(card.checklists, function (i, checklist) {
                        calcMeta(checklist);

                        $.each(checklist.checkItems, function (i, item) {
                            calcMeta(item);
                        });
                    });
                });
            });

            data.members = members;

            // Calculate all the cards each member is doing
            $.each(Progress.attrs, function (i, listType) {
                var list = getList(listType);

                $.each(members, function (i, member) {
                    member.chewy = member.chewy || {};
                    if (!list) return;
                    member.chewy[listType] = $.map(list.cards, function (card) {
                        if ($.inArray(member.id, card.idMembers) >= 0) {
                            return card;
                        }
                    });
                });
            });
            
            // Calculate the progress
            // For the templating
            data.progress = {
                planned: new Progress(),
                unplanned: new Progress()
            };

            $.each(members, function (i, member) {
                if (member.chewy.doing) {
                    member.doingNames = $.map(member.chewy.doing, function (card) {
                        return card.name;
                    });
                }
                member.progress = progressUtils.calcMemberProgress(member.chewy);

                data.progress.planned.merge(member.progress.planned);
                data.progress.unplanned.merge(member.progress.unplanned);
            });

            function calcProgressDonePoints(progress) {
                var testingMult = 0.5;
                return progress.done + (progress.testing * testingMult);
            }
            function calcMemberDonePoints(member) {
                return calcProgressDonePoints(member.progress.planned) + calcProgressDonePoints(member.progress.unplanned);
            }

            // sort the members by done points
            members.sort(function (a, b) {
                a = calcMemberDonePoints(a);
                b = calcMemberDonePoints(b);
                return b - a;
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

            function addMeta(meta) {
                // if (meta.unplanned !== unplannedToggle) return;
                progress[listType] += meta.getPoints(unplannedToggle);
            }

            if (card.meta) {
                addMeta(card.meta);
            } else {
                $.each(card.checklists, function (i, checklist) {
                    var listPoints;

                    if (checklist.meta) {
                        addMeta(checklist.meta);
                    } else {
                        listPoints = calcChecklistPoints(checklist, unplannedToggle);

                        if (listType === 'doing') {
                            progress.doing += listPoints.incomplete;
                            progress.testing += listPoints.complete;
                        } else {
                            progress[listType] += listPoints.complete + listPoints.incomplete;
                        }
                    }
                });
            }

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
                var meta = item.meta;
                if (!meta) return;
                // if (meta.unplanned !== unplannedToggle) return;

                out[item.state] += meta.getPoints(unplannedToggle);
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
        // Order matters for view
        var types = ['unplanned', 'planned'];

        function percent(amount, total) {
            return total > 0 ? amount / total : 0;
        }

        function calcBusinessDaysBetween(from, to) {
            var count = 0, from, day;

            if (from.isAfter(to)) return 0;

            from = from.clone();

            while (!from.isSame(to, 'day') && !from.isAfter(to)) {
                day = from.day();

                // sat || sun
                if (day !== 6 && day !== 0) {
                    ++count;
                }
                from.add(1, 'day');
            }

            return count;
        }

        return {
            restrict: 'A',
            scope: {
                'data': '=progressbar'
            },
            templateUrl: 'templates/progressbar.html',
            link: function (scope, el, attrs) {
                scope.progressAttrs = Progress.attrs;
                scope.segments = [];
                scope.$watch('data', function (data) {
                    var plannedTotal = data.planned.total(),
                        grandTotal = plannedTotal + data.unplanned.total(),
                        dates;

                    scope.segments = [];

                    // [todo, doing, testing, done]
                    $.each(Progress.attrs, function (i, attr) {
                        $.each(types, function (i, type) {
                            var progress = data[type];
                            scope.segments.push({
                                percent: percent(progress[attr], grandTotal),
                                list: attr,
                                type: type,
                                id: attr + '_' + type,
                                points: progress[attr]
                            });
                        });
                    });

                    scope.planned = {
                        percent: percent(plannedTotal, grandTotal),
                        points: plannedTotal
                    };

                    // Calculate date
                    dates = scope.$parent.$eval(attrs.dates);
                    if (dates) {
                        scope.time = calcBusinessDaysBetween(dates[0], moment()) / calcBusinessDaysBetween(dates[0], dates[1]);
                    } else {
                        scope.time = 0;
                    }
                });
            }
        };
    })
    .filter('grid', function () {
        return function (array, numCols) {
            var len, numRows, rows, i, j;

            numCols = numCols || 1;

            len = array.length;
            numRows = Math.floor(len / numCols);
            rows = [];

            for (i = 0; i < numRows; ++i) {
                rows[i] = [];
                rows[i].index = i;
                for (j = 0; j < numCols; ++j) {
                    rows[i][j] = array[j + i * numCols];
                }
            }

            return rows;
        };
    })
    .config(function ($locationProvider) {
        $locationProvider.html5Mode(true).hashPrefix('!');
    })
    .run(function ($location, $rootScope, $window) {
        function hasParam(name) {
            return params[name] || params[name + '/'];
        }

        var params = $location.search();
        if (hasParam('statusboard')) {
            $rootScope.statusboard = true;

            if (!hasParam('noreload')) {
                // reload in a few
                $location.search('noreload', true);

                setTimeout(function () {
                    $window.location.reload();
                }, 1000);
            }
        }
    })
    .controller('main', function ($scope, trello, storage) {
        //if (skip) return;
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

        $scope.authorize();
    })
    .controller('dashboard', function ($scope, dataHelper, storage, $timeout, $filter) {
        var timeout,
            images = ['http://media2.giphy.com/media/11EpXR36El6jU4/giphy.gif',
                'http://31.media.tumblr.com/tumblr_ltr1h3ElWS1qm0f2jo1_500.gif',
                'http://media.giphy.com/media/9BUvG6lOT32Ug/giphy.gif',
                'http://media.giphy.com/media/lqrJPaWIsjTZS/giphy.gif',
                'http://media.giphy.com/media/v1OZhO6b57iHm/giphy.gif'];

        $scope.boardId = storage.get('board') || ($scope.boards[0] && $scope.boards[0].id);
        $scope.$watch('boardId', function (value) {
            storage.set('board', value);
        });

        $scope.loadingImage = images[Math.floor(Math.random() * images.length)];

        var startDate = moment('9/30/2013');
        $scope.dates = [startDate, startDate.clone().add(2, 'weeks')];

        function reload() {
            $timeout.cancel(timeout);

            $scope.refreshStatus = 'loading';

            return dataHelper.calc($scope.boardId)
                .then(function (data) {
                    $scope.refreshStatus = 'active';
                    $scope.data = data;
                    $scope.membersGrid = $filter('grid')($scope.data.members, 2);
                }, function () {
                    $scope.refreshStatus = 'error';
                })
                .finally(function () {
                    timeout = $timeout(reload, interval);
                });
        }

        $scope.$watch('boardId', function (value) {
            if (!value) return;

            $scope.state = 'loading';
            reload().then(function () {
                $scope.state = 'active';
            }, function () {
                $scope.state = 'error';
            });
        });
    });
}());

$.backstretch('http://mantia.me/goodies/desktops/orangebricks_wide.jpg');
