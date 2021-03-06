(function () {
  "use strict"

  var utils = angular.module("ec2pricing.utils")

  utils.factory('focus', ['$rootScope', '$timeout', function ($rootScope, $timeout) {
    return function(name) {
      $timeout(function (){
        $rootScope.$broadcast('focusOn', name)
      })
    }
  }])

  utils.factory("jsonpLoader", ["$window", "$rootScope", "$q", function ($window, $rootScope, $q) {
    return function (url, callbackName) {
      var deferred = $q.defer()
      var frame = $window.document.createElement("IFRAME")
      frame.src = "about:blank"
      frame.height = "0px"
      frame.width = "0px"
      frame.style["background-color"] = "transparent"
      frame.style["border"] = "0px none transparent"
      frame.style["padding"] = "0px"
      frame.style["overflow"] = "hidden"
      $window.document.body.appendChild(frame)
      var script = frame.contentDocument.createElement("script")
      script.src = url
      frame.contentWindow[callbackName] = function (result) {
        frame.parentNode.removeChild(frame)
        $rootScope.$apply(function () { deferred.resolve(result) })
      }
      frame.contentDocument.body.appendChild(script)
      return deferred.promise
    }
  }])

  utils.factory("cache", ["$q", "localStorage", function ($q, localStorage) {
    var PREFIX = "ec2pricing:"
    var TTL = 1800000
    var cache = function (key, producer, _args) {
      var cacheKey = PREFIX + key
      var valueData = localStorage[cacheKey]
      var value = angular.fromJson(valueData)
      var age = (new Date().getTime()) - (value && value.time || 0)
      if (age < TTL) {
        return $q.when(value.value)
      } else {
        var args = Array.prototype.slice.apply(arguments)
        args.shift()
        args.shift()
        return producer.apply(null, args).then(function (value) {
          localStorage[cacheKey] = angular.toJson({time: new Date().getTime(), value: value})
          return value
        })
      }
    }
    cache.clear = function (filter) {
      angular.forEach(localStorage, function (encodedValue, key) {
        if (key.indexOf(PREFIX) == 0) {
          var unprefixedKey = key.substring(PREFIX.length)
          var unencodedValue = angular.fromJson(encodedValue)
          if (filter == null || filter(unprefixedKey, unencodedValue.value, unencodedValue.time)) {
            delete localStorage[key]
          }
        }
      })
    }
    cache.prune = function () {
      cache.clear(function (key, value, writeTime) {
        var age = (new Date().getTime()) - writeTime
        return age >= TTL
      })
    }
    return cache
  }])

  utils.factory("awsDataParser", ["instanceTypeExtras", function (instanceTypeExtras) {
    var regionMap = {
      "us-east":        "us-east-1",
      "us-west":        "us-west-1",
      "eu-ireland":     "eu-west-1",
      "apac-sin":       "ap-southeast-1",
      "apac-tokyo":     "ap-northeast-1",
      "apac-syd":       "ap-southeast-2"
    }

    var parseDisk = function (str) {
      var disk = {}
      if (str == "ebsonly") {
        disk.ebsOnly = true
        disk.disks = 0
        disk.size = 0
        disk.ssd = false
      } else if (str.match(/^\s*(\d+)\s*x\s*(\d+)\s*(\w+)?\s*$/)) {
        disk.disks = +RegExp.$1
        disk.size = +RegExp.$2
        disk.ssd = RegExp.$3 == "SSD"
      } else if (str.match(/^\s*(\d+)\s*(\w+)\s*$/)) {
        disk.disks = 1
        disk.size = +RegExp.$1
        disk.ssd = RegExp.$2 == "SSD"
      } else {
        console.warn("Could not parse disk specs", str)
      }
      return disk
    }

    var guessOsFromUrl = function (url) {
      if (url.indexOf("redhat") != -1 || url.indexOf("red-hat") != -1 || url.indexOf("rhel") != -1) {
        return "rhel"
      } else if (url.indexOf("suse") != -1 || url.indexOf("sles") != -1) {
        return "sles"
      } else if (url.toLowerCase().indexOf("mswinsqlweb") != -1) {
        return "mswinsqlweb"
      } else if (url.toLowerCase().indexOf("mswinsql") != -1) {
        return "mswinsql"
      } else if (url.indexOf("mswin") != -1 || url.indexOf("windows") != -1) {
        return "mswin"
      } else if (url.indexOf("linux") != -1) {
        return "linux"
      } else {
        return null
      }
    }

    var guessCategoryFromUrl = function (url) {
      if (url.indexOf("-od") != -1) {
        return "onDemand"
      } else if (url.indexOf("spot") != -1) {
        return "spot"
      } else if (url.indexOf("-ri-light") != -1 || url.indexOf("light_") != -1) {
        return "lightReservation"
      } else if (url.indexOf("-ri-medium") != -1 || url.indexOf("medium_") != -1) {
        return "mediumReservation"
      } else if (url.indexOf("-ri-heavy") != -1 || url.indexOf("heavy_") != -1) {
        return "heavyReservation"
      } else if (url.indexOf("ri-v2") != -1) {
        return "reservationV2"
      } else {
        return "other"
      }
    }

    return function (awsPricingFeeds) {
      var instanceTypes = {}
      var regions = {}
      var operatingSystems = {}

      var createInstanceType = function (apiName) {
        return {apiName: apiName, prices: {}}
      }

      var ensurePricingProperties = function (instanceType, regionName, pricingCategory, operatingSystem) {
        var regionPrices = instanceType.prices[regionName]
        if (!regionPrices) {
          regionPrices = instanceType.prices[regionName] = {}
        }
        var pricingCategoryData = regionPrices[pricingCategory]
        if (!pricingCategoryData) {
          pricingCategoryData = regionPrices[pricingCategory] = {}
        }
        var osPricing = pricingCategoryData[operatingSystem]
        if (!osPricing) {
          osPricing = pricingCategoryData[operatingSystem] = {}
        }
        return pricingCategoryData
      }

      awsPricingFeeds.forEach(function (awsPricing) {
        var operatingSystem = guessOsFromUrl(awsPricing.url)
        var pricingCategory = guessCategoryFromUrl(awsPricing.url)

        awsPricing.config.regions.forEach(function (awsRegion) {
          var regionName = regionMap[awsRegion.region] || awsRegion.region
          regions[regionName] = regionName

          if (awsRegion.instanceTypes) {
            if (operatingSystem) {
              operatingSystems[operatingSystem.toLowerCase()] = operatingSystem.toLowerCase()
            }

            awsRegion.instanceTypes.forEach(function (awsInstanceFamily) {
              if ("sizes" in awsInstanceFamily) {
                awsInstanceFamily.sizes.forEach(function (awsInstanceType) {
                  var instanceType = instanceTypes[awsInstanceType.size]
                  if (!instanceType) {
                    instanceType = instanceTypes[awsInstanceType.size] = createInstanceType(awsInstanceType.size)
                  }
                  instanceType.cpus = instanceType.cpus || awsInstanceType.vCPU
                  instanceType.ram = instanceType.ram || +awsInstanceType.memoryGiB
                  instanceType.disk = instanceType.disk || awsInstanceType.storageGB && parseDisk(awsInstanceType.storageGB)
                  awsInstanceType.valueColumns.forEach(function (awsValueColumn) {
                    var pricingCategoryData = ensurePricingProperties(instanceType, regionName, pricingCategory, operatingSystem)
                    if (pricingCategory.match(/reservation/i) != null) {
                      var value = +awsValueColumn.prices.USD
                      if (value && !isNaN(value)) {
                        pricingCategoryData[operatingSystem][awsValueColumn.name] = value
                      }
                    } else {
                      if (awsValueColumn.name == "os") {
                        pricingCategoryData[operatingSystem] = +awsValueColumn.prices.USD
                      } else if (awsValueColumn.name == "ebsOptimized") {
                        pricingCategoryData[awsValueColumn.name] = +awsValueColumn.prices.USD
                      } else if (awsValueColumn.name != "ec2") {
                        pricingCategoryData[awsValueColumn.name.toLowerCase()] = +awsValueColumn.prices.USD
                      }
                    }
                  })
                })
              } else if ("type" in awsInstanceFamily) {
                var instanceType = instanceTypes[awsInstanceFamily.type]
                if (!instanceType) {
                  instanceType = instanceTypes[awsInstanceFamily.type] = createInstanceType(awsInstanceFamily.type)
                }
                awsInstanceFamily.terms.forEach(function (term) {
                  term.purchaseOptions.forEach(function (purchaseOption) {
                    var pricingCategoryData = ensurePricingProperties(instanceType, regionName, purchaseOption.purchaseOption, operatingSystem)
                    purchaseOption.valueColumns.forEach(function (valueColumn) {
                      var key = term.term + "-" + valueColumn.name
                      pricingCategoryData[operatingSystem][key] = +valueColumn.prices.USD
                    })
                  })
                })
              }
            })
          } else {
            // TODO: parse other pricing data
          }
        })
      })

      var instanceTypesList = []
      var regionList = []
      var operatingSystemsList = []

      angular.forEach(instanceTypes, function (instanceType) {
        var extras = instanceTypeExtras[instanceType.apiName]
        if (extras) {
          angular.extend(instanceType, extras)
        }
        instanceTypesList.push(instanceType)
      })

      angular.forEach(regions, function (region) {
        regionList.push(region)
      })

      angular.forEach(operatingSystems, function (operatingSystem) {
        if (operatingSystem && operatingSystem !== "") {
          operatingSystemsList.push(operatingSystem)
        }
      })

      return {
        regions: regionList,
        operatingSystems: operatingSystemsList,
        instanceTypes: instanceTypesList
      }
    }
  }])

  utils.factory("pricingDataLoader", ["$q", "pricingUrls", "jsonpLoader", "cache", "awsDataParser", function ($q, pricingUrls, jsonpLoader, cache, awsDataParser) {
    var load = function () {
      var promises = pricingUrls.map(function (url) {
        return jsonpLoader(url, "callback").then(function (data) {
          data.url = url
          return data
        })
      })
      var allLoaded = $q.defer()
      var dataFeeds = []
      promises.forEach(function (promise) {
        promise.then(function (data) {
          dataFeeds.push(data)
          allLoaded.notify(dataFeeds.length/promises.length)
          if (dataFeeds.length == promises.length) {
            allLoaded.resolve(awsDataParser(dataFeeds))
          }
        })
      })
      return allLoaded.promise
    }
    var cachedLoad = function () {
      return cache("pricingData", load)
    }
    return {
      load: cachedLoad
    }
  }])
}())
