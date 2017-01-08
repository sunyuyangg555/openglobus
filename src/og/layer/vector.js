goog.provide('og.layer.Vector')

goog.require('og.EntityCollection');
goog.require('og.Entity');
goog.require('og.LonLat');
goog.require('og.quadTree');
goog.require('og.quadTree.EntityCollectionQuadNode');
goog.require('og.math');
goog.require('og.inheritance');
goog.require('og.QueueArray');

/**
 * Vector layer represents alternative entities store. Used for geospatial data rendering like 
 * points, lines, polygons, geometry objects etc.
 * @class
 * @extends {og.layer.Layer}
 * @param {string} [name="noname"] - Layer name.
 * @param {Object} [options] - Layer options:
 * @param {number} [options.minZoom=0] - Minimal visible zoom. 0 is default
 * @param {number} [options.maxZoom=50] - Maximal visible zoom. 50 is default.
 * @param {string} [options.attribution] - Layer attribution.
 * @param {string} [options.zIndex=0] - Layer Z-order index. 0 is default.
 * @param {boolean} [options.visibility=true] - Layer visibility. True is default.
 * @param {boolean} [options.isBaseLayer=false] - Layer base layer. False is default.
 * @param {Array.<og.Entity>} [options.entities] - Entities array.
 * @param {Array.<number,number,number>} [options.scaleByDistance] - Scale by distance parameters.
 *      First index - near distance to the entity, after entity becomes full scale.
 *      Second index - far distance to the entity, when entity becomes zero scale.
 *      Third index - far distance to the entity, when entity becomes invisible.
 * @param {number} [options.maxCountNode=30] - Maximum entities quantity in the tree node. Rendering optimization parameter. 30 is default.
 * @param {boolean} [options.async=true] - Asynchronous vector data handling before rendering. True for optimization huge data.
 * @param {boolean} [options.groundAlign = false] - Vector data align to the ground relief. Like points with zero altitude lay on the ground.
 *
 * @fires og.layer.Vector#entitymove
 * @fires og.layer.Vector#draw
 * @fires og.layer.Vector#add
 * @fires og.layer.Vector#remove
 * @fires og.layer.Vector#entityadd
 * @fires og.layer.Vector#entityremove
 * @fires og.layer.Vector#visibilitychange
 */
og.layer.Vector = function (name, options) {
    options = options || {};

    og.inheritance.base(this, name, options);

    this.events.registerNames(og.layer.Vector.EVENT_NAMES);

    /**
     * First index - near distance to the entity, after that entity becomes full scale.
     * Second index - far distance to the entity, when entity becomes zero scale.
     * Third index - far distance to the entity, when entity becomes invisible.
     * @public
     * @type {Array.<number,number,number>}
     */
    this.scaleByDistance = options.scaleByDistance || [og.math.MAX32, og.math.MAX32, og.math.MAX32];

    /**
     * Asynchronous data handling before rendering.
     * @public
     * @type {boolean}
     */
    this.async = options.async != undefined ? options.async : true;

    /**
     * Vector data ground align flag.
     * @public
     * @type {boolean}
     */
    this.groundAlign = options.groundAlign || false;

    /**
     * Maximum entities quantity in the tree node.
     * @private
     */
    this._maxCountPerCollection = options.maxCountNode || 30;

    /**
     * Manimal tree node deep index.
     * @private
     */
    this._minTreeZoom = 5;

    /**
     * Stored entities.
     * @private
     */
    this._entities = options.entities ? [].concat(options.entities) : [];

    this._entityCollectionAlways = new og.EntityCollection();
    this._bindEventsDefault(this._entityCollectionAlways);

    this._entityCollectionsTree = null;
    this._entityCollectionsTreeNorth = null;
    this._entityCollectionsTreeSouth = null;

    this._renderingNodes = {};
    this._renderingNodesNorth = {};
    this._renderingNodesSouth = {};

    this._counter = 0;
    this._deferredEntitiesPendingQueue = new og.QueueArray();

    /** Creates collections tree*/
    this._buildEntityCollectionsTree();
};

og.inheritance.extend(og.layer.Vector, og.layer.Layer);

og.layer.Vector.EVENT_NAMES = [
        /**
         * Triggered when entity has moved.
         * @event og.layer.Vector#draw
         */
        "entitymove",

        /**
         * Triggered when layer begin draw.
         * @event og.layer.Vector#draw
         */
        "draw",

        /**
         * Triggered when new entity added to the layer.
         * @event og.layer.Vector#entityadd
         */
        "entityadd",

        /**
         * Triggered when entity removes from the collection.
         * @event og.layer.Vector#entityremove
         */
        "entityremove"
];

/**
 * Vector layer {@link og.layer.Vector} object factory.
 * @static
 * @returns {og.layer.Vector} Returns vector layer.
 */
og.layer.vector = function (name, options) {
    return new og.layer.Vector(name, options);
};

/**
 * Adds layer to the planet.
 * @public
 */
og.layer.Vector.prototype.addTo = function (planet) {
    this._assignPlanet(planet);
    this._entityCollectionAlways.addTo(planet, true);
    this._buildEntityCollectionsTree();
    return this;
};

/**
 * Returns stored entities.
 * @public
 * @returns {Array.<og.Entity>}
 */
og.layer.Vector.prototype.getEntities = function () {
    return [].concat(this._entities);
};

/**
 * @private
 */
og.layer.Vector.prototype._fitExtent = function (entity) {
    if (entity._lonlat.lon > this._extent.northEast.lon) {
        this._extent.northEast.lon = entity._lonlat.lon;
    }
    if (entity._lonlat.lat > this._extent.northEast.lat) {
        this._extent.northEast.lat = entity._lonlat.lat;
    }
    if (entity._lonlat.lon < this._extent.southWest.lon) {
        this._extent.southWest.lon = entity._lonlat.lon;
    }
    if (entity._lonlat.lat < this._extent.southWest.lat) {
        this._extent.southWest.lat = entity._lonlat.lat;
    }
};

/**
 * Adds entity to the layer.
 * @public
 * @param {og.Entity} entity - Entity.
 * @param {boolean} [rightNow] - Entity insertion option. False is deafult.
 * @returns {og.layer.Vector} - Returns this layer.
 */
og.layer.Vector.prototype.add = function (entity, rightNow) {
    if (!(entity._vectorLayer || entity._entityCollection)) {
        entity._vectorLayer = this;
        entity._vectorLayerIndex = this._entities.length;
        this._entities.push(entity);

        if (entity.lineString) {
            this._entityCollectionAlways.add(entity);
        } else if (this._planet) {
            if (!entity._lonlat) {
                entity._lonlat = this.layer._planet.ellipsoid.cartesianToLonLat(entity._cartesian);
            }

            this._fitExtent(entity);

            //poles trees
            if (entity._lonlat.lat > og.mercator.MAX_LAT) {
                this._entityCollectionsTreeNorth.insertEntity(entity, rightNow);
            } else if (entity._lonlat.lat < og.mercator.MIN_LAT) {
                this._entityCollectionsTreeSouth.insertEntity(entity, rightNow);
            } else {
                this._entityCollectionsTree.insertEntity(entity, rightNow);
            }
        }

        this.events.dispatch(this.events.entityadd, entity);
    }
    return this;
};

/**
 * Adds entity array to the layer.
 * @public
 * @param {Array.<og.Entity>} entities - Entities array.
 * @param {boolean} [rightNow] - Entity insertion option. False is deafult.
 * @returns {og.layer.Vector} - Returns this layer.
 */
og.layer.Vector.prototype.addEntities = function (entities, rightNow) {
    var i = entities.length;
    while (i--) {
        this.add(entities[i], rightNow);
    }
    return this;
};

/**
 * Remove entity from layer.
 * TODO: memory leaks.
 * @public
 * @param {og.Entity} entity - Entity to remove.
 * @returns {og.layer.Vector} - Returns this layer.
 */
og.layer.Vector.prototype.removeEntity = function (entity) {
    if (entity._vectorLayer && this.isEqual(entity._vectorLayer)) {
        this._entities.splice(entity._vectorLayerIndex, 1);
        this._reindexEntitiesArray(entity._vectorLayerIndex);
        entity._vectorLayer = null;
        entity._vectorLayerIndex = -1;

        if (entity._entityCollection) {
            entity._entityCollection._removeEntitySilent(entity);
            var node = entity._nodePtr;
            while (node) {
                node.count--;
                node = node.parentNode;
            }
            if (entity._nodePtr && entity._nodePtr.count === 0 &&
                entity._nodePtr.deferredEntities.length === 0) {
                entity._nodePtr.entityCollection = null;
                //
                //...
                //
            }
        } else if (entity._nodePtr &&
            entity._nodePtr.deferredEntities.length) {
            var defEntities = entity._nodePtr.deferredEntities;
            var j = defEntities.length;
            while (j--) {
                if (defEntities[j].id === entity.id) {
                    defEntities.splice(j, 1);
                    var node = entity._nodePtr;
                    while (node) {
                        node.count--;
                        node = node.parentNode;
                    }
                    break;
                }
            }
        }
        entity._nodePtr && (entity._nodePtr = null);
        this.events.dispatch(this.events.entityremove, entity);
    }
    return this;
};

/**
 * Set layer picking events active.
 * @public
 * @param {number} enable
 */
og.layer.Vector.prototype.setPickingEnabled = function (enable) {
    this._entityCollectionAlways.setPickingEnabled(enable);
    this._entityCollectionsTree.traverseTree(function (ec) {
        ec.setPickingEnabled(enable);
    });
    this._entityCollectionsTreeNorth.traverseTree(function (ec) {
        ec.setPickingEnabled(enable);
    });
    this._entityCollectionsTreeSouth.traverseTree(function (ec) {
        ec.setPickingEnabled(enable);
    });
};

/**
 * Refresh collected entities indexes from startIndex entitytes collection array position.
 * @public
 * @param {number} startIndex - Entity array index.
 */
og.layer.Vector.prototype._reindexEntitiesArray = function (startIndex) {
    var e = this._entities;
    for (var i = startIndex; i < e.length; i++) {
        e[i]._vectorLayerIndex = i;
    }
};

/**
 * Removes entities from layer.
 * @public
 * @param {Array.<og.Entity>} entities - Entity array.
 * @returns {og.layer.Vector} - Returns this layer.
 */
og.layer.Vector.prototype.removeEntities = function (entities) {
    var i = entities.length;
    while (i--) {
        this.removeEntity(entities[i]);
    }
    return this;
};

/**
 * Removes current entities from layer and adds new entities.
 * @public
 * @param {Array.<og.Entity>} entities - New entity array.
 */
og.layer.Vector.prototype.setEntities = function (entities) {
    this.clear();
    this._entities = [].concat(entities);
    var i = entities.length;
    while (i--) {
        var ei = entities[i];
        if (!ei._vectorLayer) {
            ei._vectorLayer = this;
            ei._vectorLayerIndex = i;
        }
    }
    this._buildEntityCollectionsTree();
    return this;
};

/**
 * Sets scale by distance parameters.
 * @public
 * @param {number} near - Full scale entity distance.
 * @param {number} far - Zerol scale entity distance.
 * @param {number} [farInvisible] - Entity visibility distance.
 */
og.layer.Vector.prototype.setScaleByDistance = function (near, far, farInisible) {
    this.scaleByDistance[0] = near;
    this.scaleByDistance[1] = far;
    this.scaleByDistance[2] = farInisible || og.math.MAX32;
    return this;
};

/**
 * TODO: Clear the layer.
 * @public
 */
og.layer.Vector.prototype.clear = function () {
    //TODO
};

/**
 * Safety entities loop.
 * @public
 * @param {callback} callback - Entity callback.
 */
og.layer.Vector.prototype.each = function (callback) {
    var e = this._entities;
    var i = e.length;
    while (i--) {
        callback(e[i]);
    }
};

og.layer.Vector.prototype._buildEntityCollectionsTree = function () {

    this._extent = new og.Extent(new og.LonLat(180, 90), new og.LonLat(-180, -90));

    if (this._planet) {
        this._entityCollectionsTree = new og.quadTree.EntityCollectionQuadNode(this, og.quadTree.NW, null, 0,
            og.Extent.createFromArray([-20037508.34, -20037508.34, 20037508.34, 20037508.34]), this._planet, 0);

        this._entityCollectionsTreeNorth = new og.quadTree.EntityCollectionQuadNodeWGS84(this, og.quadTree.NW, null, 0,
            og.Extent.createFromArray([-180, og.mercator.MAX_LAT, 180, 90]), this._planet, 0);

        this._entityCollectionsTreeSouth = new og.quadTree.EntityCollectionQuadNodeWGS84(this, og.quadTree.NW, null, 0,
            og.Extent.createFromArray([-180, -90, 180, og.mercator.MIN_LAT]), this._planet, 0);

        var entities = [];
        for (var i = 0; i < this._entities.length; i++) {
            var ei = this._entities[i];
            if (ei.lineString) {
                this._entityCollectionAlways.add(ei);
            } else {
                entities.push(ei);
            }
        }
        this._entityCollectionsTree.buildTree(entities);
        this._entityCollectionsTreeNorth.buildTree(entities);
        this._entityCollectionsTreeSouth.buildTree(entities);
    }
};

og.layer.Vector.prototype._bindEventsDefault = function (entityCollection) {
    var ve = this.events;
    entityCollection.events.on("entitymove", function (e) { ve.dispatch(ve.entitymove, e); });
    entityCollection.events.on("mousemove", function (e) { ve.dispatch(ve.mousemove, e); });
    entityCollection.events.on("mouseenter", function (e) { ve.dispatch(ve.mouseenter, e); });
    entityCollection.events.on("mouseleave", function (e) { ve.dispatch(ve.mouseleave, e); });
    entityCollection.events.on("mouselbuttonclick", function (e) { ve.dispatch(ve.mouselbuttonclick, e); });
    entityCollection.events.on("mouserbuttonclick", function (e) { ve.dispatch(ve.mouserbuttonclick, e); });
    entityCollection.events.on("mousembuttonclick", function (e) { ve.dispatch(ve.mousembuttonclick, e); });
    entityCollection.events.on("mouselbuttondoubleclick", function (e) { ve.dispatch(ve.mouselbuttondoubleclick, e); });
    entityCollection.events.on("mouserbuttondoubleclick", function (e) { ve.dispatch(ve.mouserbuttondoubleclick, e); });
    entityCollection.events.on("mousembuttondoubleclick", function (e) { ve.dispatch(ve.mousembuttondoubleclick, e); });
    entityCollection.events.on("mouselbuttonup", function (e) { ve.dispatch(ve.mouselbuttonup, e); });
    entityCollection.events.on("mouserbuttonup", function (e) { ve.dispatch(ve.mouserbuttonup, e); });
    entityCollection.events.on("mousembuttonup", function (e) { ve.dispatch(ve.mousembuttonup, e); });
    entityCollection.events.on("mouselbuttondown", function (e) { ve.dispatch(ve.mouselbuttondown, e); });
    entityCollection.events.on("mouserbuttondown", function (e) { ve.dispatch(ve.mouserbuttondown, e); });
    entityCollection.events.on("mousembuttondown", function (e) { ve.dispatch(ve.mousembuttondown, e); });
    entityCollection.events.on("mouselbuttonhold", function (e) { ve.dispatch(ve.mouselbuttonhold, e); });
    entityCollection.events.on("mouserbuttonhold", function (e) { ve.dispatch(ve.mouserbuttonhold, e); });
    entityCollection.events.on("mousembuttonhold", function (e) { ve.dispatch(ve.mousembuttonhold, e); });
    entityCollection.events.on("mousewheel", function (e) { ve.dispatch(ve.mousewheel, e); });
    entityCollection.events.on("touchmove", function (e) { ve.dispatch(ve.touchmove, e); });
    entityCollection.events.on("touchstart", function (e) { ve.dispatch(ve.touchstart, e); });
    entityCollection.events.on("touchend", function (e) { ve.dispatch(ve.touchend, e); });
    entityCollection.events.on("doubletouch", function (e) { ve.dispatch(ve.doubletouch, e); });
    entityCollection.events.on("touchleave", function (e) { ve.dispatch(ve.touchleave, e); });
    entityCollection.events.on("touchenter", function (e) { ve.dispatch(ve.touchenter, e); });
};

og.layer.Vector.prototype._collectVisibleCollections = function (outArr) {
    if (this.minZoom <= this._planet.maxCurrZoom && this.maxZoom >= this._planet.maxCurrZoom) {

        this._renderingNodes = {};
        this._renderingNodesNorth = {};
        this._renderingNodesSouth = {};

        outArr.push(this._entityCollectionAlways);

        this._secondPASS = [];
        this._entityCollectionsTree.collectRenderCollections(this._planet._visibleNodes, outArr);
        var i = this._secondPASS.length;
        while (i--) {
            this._secondPASS[i].collectRenderCollectionsPASS2(this._planet._visibleNodes, outArr, this._secondPASS[i].nodeId);
        }

        this._secondPASS = [];
        this._entityCollectionsTreeNorth.collectRenderCollections(this._planet._visibleNodesNorth, outArr);
        i = this._secondPASS.length;
        while (i--) {
            this._secondPASS[i].collectRenderCollectionsPASS2(this._planet._visibleNodesNorth, outArr, this._secondPASS[i].nodeId);
        }

        this._secondPASS = [];
        this._entityCollectionsTreeSouth.collectRenderCollections(this._planet._visibleNodesSouth, outArr);
        i = this._secondPASS.length;
        while (i--) {
            this._secondPASS[i].collectRenderCollectionsPASS2(this._planet._visibleNodesSouth, outArr, this._secondPASS[i].nodeId);
        }
    }
};

og.layer.Vector.prototype._queueDeferredNode = function (node) {
    if (this._visibility) {
        node._inTheQueue = true;
        if (this._counter >= 1) {
            this._deferredEntitiesPendingQueue.push(node);
        } else {
            this._execDeferredNode(node);
        }
    }
};

og.layer.Vector.prototype._execDeferredNode = function (node) {
    this._counter++;
    var that = this;
    setTimeout(function () {
        node.applyCollection();
        that._dequeueRequest();
    }, 0);
};

og.layer.Vector.prototype._dequeueRequest = function () {
    this._counter--;
    if (this._deferredEntitiesPendingQueue.length && this._counter < 1) {
        var node;
        if (node = this._whilePendings())
            this._execDeferredNode(node);
    }
};

og.layer.Vector.prototype._whilePendings = function () {
    while (this._deferredEntitiesPendingQueue.length) {
        var node = this._deferredEntitiesPendingQueue.pop();
        node._inTheQueue = false;
        if (node.isVisible()) {
            return node;
        }
    }
    return null;
};